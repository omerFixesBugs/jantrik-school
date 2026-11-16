# Sprint 1, P1-J: the app login can no longer read password hashes (implementation plan)

**Status: written and built during the unattended day run of 2026-11-16, for the owner's review
together with the PR** (the owner asked for this: "write the plan, then build it, since I am
away; I will review plan and PR together before merging"). Nothing is merged by Claude. The
follow-up is P1-J in [decisions-pending.md](../decisions-pending.md); the phase is
[sprint-1-p1-staff-password.md](sprint-1-p1-staff-password.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (one implementer,
> one database-security review subagent at the end). Steps use checkbox (`- [ ]`) syntax.

## Changed after the review (P1-J7; the owner may drop these commits)

The database-security review found that the first design below left an oracle as good as the
hash: as `jantrik_app`, an injection could read any user's salt from `auth_find_user_for_login`,
set `app.user_id` to them, and check 200,000 offline-computed guesses against
`auth_my_password_matches` in one statement (6.4 s on the scratch database). What was built
instead, and what this plan's sections below describe only where they say so:

- **A dedicated login, `jantrik_login_app`** (`DATABASE_LOGIN_URL`), like the platform and
  receiver logins: LOGIN, no table grants, a member of no role, not a member of `jantrik_app`. It
  may run one function, `auth_find_user_for_password_login(phone, email)`, which returns the
  stored hash; `jantrik_app` may not run it. `LoginPrismaService` (a small pool, used by
  `AuthService.loginWithPassword` only) checks at start-up that the login is not privileged (fail
  closed) and not mixed up with `DATABASE_URL`.
- **The API verifies with argon2 as before** (`PasswordService.verify`, dummy hash for unknown
  users). The digest exchange (`loginDigest`, `auth_my_password_matches`) is gone, and with it the
  format restriction (P1-J5). The cost ceiling (P1-J4) stays, now in `verify`.
- **`auth_find_user_for_login`** (the app's) returns id, name and locale only.
- **What an injection in an ordinary request can and cannot do now:** it cannot read any hash or
  salt, its own or anyone's, and cannot run the password lookup. It can learn whether a given
  person has a password (yes or no) through `auth_my_password_is_set()` with a `set_config` of
  `app.user_id` (P1-J2).
- **Guards:** `schema-safety.test.ts` checks that `jantrik_app` may read every `users` column but
  the hash (a new column without its GRANT fails), pins by name every definer function a runtime
  login may run whose owner can read the hash, refuses any function that returns the hash or a
  whole users row except the password lookup, and holds `jantrik_login_app` to that one function.
- **Setup:** the role in `01-roles.sh`, `create-roles.sh`, the production compose and its
  settings example, the restore check, CI and `.env.example`. On an existing machine: create the
  role once (database.md → Database roles) and add `DATABASE_LOGIN_URL` to `.env`. On an existing
  server: deploy.md → Upgrades (create the role before the migration; the old API fails some reads
  between migrate and restart).

**Goal:** an SQL injection in any institute request (which runs as `jantrik_app`) can no longer
read a staff member's argon2 password hash, neither of co-members nor of anyone else. Everything
the app needs keeps working: password login, `GET /me/password` (`hasPassword`), setting a
password, and every read of `users`.

**Architecture:** `jantrik_app` loses SELECT on `users.password_hash` (it keeps UPDATE, so setting
a password still works). The login lookup stops returning the hash: it returns only the hash's
parameters and salt, the API computes the argon2 hash of the typed password with them, and a
narrow definer function compares the two inside the database and answers yes or no. The hash's
digest never leaves the database. `hasPassword` comes from a second narrow definer function.
Every Prisma client omits `passwordHash` from its reads, so no read or update ever names the
column.

**Tech stack:** PostgreSQL 16 column privileges and `SECURITY DEFINER` functions (built-in
`sha256()`), Prisma 7 global `omit`, `@node-rs/argon2` (as today). No new dependency.

## What exists today

- `users` is granted to `jantrik_app` as `GRANT SELECT, INSERT, UPDATE, DELETE` (init migration),
  narrowed later: no INSERT/DELETE, UPDATE only on six columns (P1-B). **SELECT is table-level,
  so a column REVOKE alone would do nothing.**
- RLS (`users_visible`): the app sees itself and the members of the current institute. A request
  that is injected into can read their `password_hash` (P1-J as recorded).
- **A wider hole than P1-J names:** `auth_find_user_for_login(phone, email)` is a definer function
  executable by `jantrik_app`, and it returns `password_hash` of **any** user by phone or email,
  whatever the institute. Phones of co-members are readable, and phones are guessable. Hiding the
  column without changing this function would close nothing. This plan changes both.
- The API reads the hash in two places: the password login (`AuthService.loginWithPassword` →
  `PasswordService.verify`) and `GET /me/password` (`user.passwordHash !== null`).
- Full-row reads or updates of `users` by the app login (each would fail once SELECT on the
  column is gone, because Prisma names every column, also in `RETURNING`):
  - `AuthService` (`me`: `findUniqueOrThrow` without `select`), `MeModule` (`update` without
    `select`), `PasswordSettingsService.set` (`update`);
  - the demo seed (`demo.ts`: the staff password and Bangla names are set as each user, through
    the app login), the API test harness (`addMember` with a password);
  - tests: `users-rls`, `invitations-rls`, `me`, `name-bn`, `no-global-names`, `password`,
    `student-imports`.
- The platform admins' login (`platform_find_admin_for_login`) returns `platform_admins`
  hashes to `jantrik_platform_app`, a separate login with no tenant traffic. **Out of scope**
  (recorded in "Not in this plan").

## Design

### The database (one migration, `20261116000000_users_password_hash_hidden`)

```sql
-- 1. Column privileges: everything but password_hash (a future column needs its own GRANT).
REVOKE SELECT ON users FROM jantrik_app;
GRANT SELECT (id, phone, email, name, name_bn, password_changed_at, locale, color_scheme,
              created_at, updated_at) ON users TO jantrik_app;

-- 2. The login lookup returns the hash's parameters and salt, never its digest.
DROP FUNCTION auth_find_user_for_login(text, text);
CREATE FUNCTION auth_find_user_for_login(p_phone text, p_email text)
  RETURNS TABLE (id uuid, name text, locale locale, password_params text)
  ... SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT u.id, u.name, u.locale,
           substring(u.password_hash FROM
             '^(\$argon2id\$v=19\$m=[0-9]{1,10},t=[0-9]{1,10},p=[0-9]{1,3}\$[A-Za-z0-9+/]{11,64})\$[A-Za-z0-9+/]{43}$')
    FROM users u
    WHERE (p_phone IS NOT NULL AND u.phone = p_phone)
       OR (p_email IS NOT NULL AND lower(u.email) = lower(p_email))
    LIMIT 1
  $$;

-- 3. Does the current user's hash equal the one the API computed? (sha256 of both PHC strings)
CREATE FUNCTION auth_my_password_matches(p_digest bytea) RETURNS boolean
  ... SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = app_current_user_id()
        AND u.password_hash IS NOT NULL
        AND sha256(convert_to(u.password_hash, 'UTF8')) = p_digest)
  $$;

-- 4. Has the current user set a password? (GET /me/password)
CREATE FUNCTION auth_my_password_is_set() RETURNS boolean
  ... SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM users u
                   WHERE u.id = app_current_user_id() AND u.password_hash IS NOT NULL)
  $$;
```

Each function: `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO jantrik_app`, then
`ALTER FUNCTION … OWNER TO jantrik_auth` (privileges before the owner change, database.md).
`jantrik_auth` already has SELECT on `users` and an `auth_lookup` policy.

- The pattern accepts only what `@node-rs/argon2` writes today (argon2id, version 19, a 32-byte
  digest). Any other stored value returns NULL: that person cannot sign in with a password, as
  with a corrupt hash today, and can set a new one after a phone code.
- The two new functions take no id: they are scoped by `app_current_user_id()`, like
  `auth_list_my_memberships()`, so they fit the existing schema-safety rules (no uuid parameter,
  scoped by context) without a new exception.

### The password login (API)

`AuthService.loginWithPassword`:

1. `auth_find_user_for_login` → `{ id, name, locale, password_params }` (as today, but no hash).
2. `PasswordService.loginDigest(params, password)`: parse `params` (argon2id, v=19, `m`, `t`, `p`,
   salt); compute `hash(nfc(password), { memoryCost: m, timeCost: t, parallelism: p, salt })`;
   check it starts with `params + '$'`; return `sha256` of the whole PHC string. When the user is
   unknown, has no password, or the parameters are missing, malformed or above the cost ceiling
   (`m` ≤ 65 536 KiB, `t` ≤ 10, `p` ≤ 4), it computes the same hash with the default parameters
   and a fixed dummy salt, so the time does not reveal which case it was.
3. `auth_my_password_matches(digest)` in a transaction with `app.user_id` = the user's id, or the
   nil UUID when there is no user (the same number of database round trips either way).
4. Everything after (staff check, limiter reset, session) is unchanged.

`PasswordService.verify` stays for the platform admins' login.

### `hasPassword` and the reads of `users`

- `PasswordSettingsService.status` reads `phone` and `passwordChangedAt` as today, and
  `hasPassword` from `SELECT auth_my_password_is_set()` in the request's transaction.
- **Every Prisma client omits `passwordHash`** (`createPrismaClient` passes
  `omit: { user: { passwordHash: true } }`). The package's `PrismaClient` type becomes that
  client's type and the generated class is no longer exported, so every client is built by the
  factory and TypeScript refuses code that reads `user.passwordHash`. A query that really needs
  it (the owner login in tests) asks with `omit: { passwordHash: false }`.
- Writes are unchanged: `PasswordSettingsService` still writes the hash (UPDATE privilege kept);
  Prisma's `RETURNING` no longer names the column.

### Guarding it

- `schema-safety.test.ts`:
  - `jantrik_app` has no table-level SELECT on `users`, and exactly these selectable columns
    (pinned list: a new column needs a deliberate GRANT and a test change);
  - no login role (`jantrik_app`, `jantrik_platform_app`, `jantrik_ingest_app`) and not PUBLIC
    may SELECT `password_hash`;
  - no definer function executable by `jantrik_app` returns a column named `password_hash`
    (`pg_proc.proargnames` of the result columns), so the hole cannot come back through a new
    function.
- The two new functions join the "scoped by context" list.

## Review focus

1. **The digest never reaches `jantrik_app`:** not through `users`, not through any function, not
   in an error message.
2. **No timing difference** between an unknown phone, a user without a password and a wrong
   password (one argon2 hash and one transaction each).
3. **(Wrong in the first version, see "Changed after the review".)** The first version said the
   remaining oracle allowed one query per guess. In fact the salt was readable and one statement
   could test 200,000 guesses, close to reading the hash. The oracle is gone; what is left is one
   bit per person ("has a password", P1-J2).
4. **Nothing else broke:** the seed (demo passwords and Bangla names), the API harness, every
   `users` read.

## Decisions taken in this plan (the owner reviews them with the PR)

| #     | Decision                                                       | Taken (safest)                                                                                                                                                                     |
| ----- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-J1 | The login lookup returned any user's hash                      | Closed too: it returns parameters and salt only; the database compares (otherwise hiding the column achieves nothing)                                                              |
| P1-J2 | How `hasPassword` is read                                      | A definer function for the current user only (`auth_my_password_is_set()`), no parameter                                                                                           |
| P1-J3 | Full-row reads of `users`                                      | Every Prisma client omits `passwordHash` (typed), instead of a `select` on each call site; the column is unreadable either way                                                     |
| P1-J4 | Argon2 cost ceiling at login (`m` ≤ 64 MiB, `t` ≤ 10, `p` ≤ 4) | Above it the stored hash is treated as unusable; today's are 19 MiB / 2 / 1. It stops a hash someone wrote into their own row from making each login attempt arbitrarily expensive |
| P1-J5 | Hashes in another format (not argon2id v19, 32 bytes)          | Cannot sign in with a password until the person sets one again after a phone code; every hash Jantrik writes has this format                                                       |
| P1-J6 | Platform admins' hashes (`platform_find_admin_for_login`)      | Not in this PR: a separate login with no tenant requests; the same change can follow if wanted                                                                                     |

## Files

| File                                                                                    | What                                                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/db/prisma/migrations/20261116000000_users_password_hash_hidden/migration.sql` | grants and the three functions                                            |
| `packages/db/src/client.ts` (new), `src/index.ts`, `src/tenancy/context.ts` and others  | the factory with `omit`, the `PrismaClient` and `TransactionClient` types |
| `packages/db/test/users-password-hash.test.ts` (new)                                    | the column, the functions, the timing-neutral paths                       |
| `packages/db/test/schema-safety.test.ts`, `auth-functions.test.ts`, `users-rls.test.ts` | guards; reads through the owner where a test needs the hash               |
| `apps/api/src/auth/login-lookup.ts`, `auth.service.ts`, `password.service.ts`           | the login                                                                 |
| `apps/api/src/auth/password-settings.service.ts`                                        | `hasPassword`                                                             |
| `apps/api/src/auth/password.service.spec.ts` (new)                                      | parsing the parameters, the ceiling, the dummy path                       |
| `apps/api/test/*.e2e-spec.ts`, `test/support/harness.ts`                                | tests that read the hash use the owner login                              |
| `docs/database.md`, `docs/auth.md`, `docs/decisions-pending.md`                         | docs                                                                      |

## Tasks

### Task 1: The column and the functions (database)

- [ ] Test first (`packages/db/test/users-password-hash.test.ts`), as the app login:
  - `SELECT password_hash FROM users` (self, in context) fails with "permission denied";
  - `SELECT * FROM users` fails the same way; `SELECT id, phone, name … FROM users` works;
  - `auth_find_user_for_login` returns `password_params` equal to the stored hash up to its last
    `$`, and NULL for a user without a password or with a malformed hash;
  - `auth_my_password_matches(sha256(stored))` is true in the user's context, false in another
    user's context, false without context, false for a user without a password;
  - `auth_my_password_is_set()` true/false/false-without-context;
  - updating the own `password_hash` still works (and the owner, in the user's context, reads it).
- [ ] Run → fails (column readable, functions missing).
- [ ] Migration; then the test passes.
- [ ] `schema-safety.test.ts` and `auth-functions.test.ts` updated (column pins, the function
      lists); `users-rls.test.ts` reads the written hash through the owner.
- [ ] Commit.

### Task 2: Every client omits the hash (packages/db)

- [ ] `createPrismaClient` with `CLIENT_OMIT`; the `PrismaClient` and `TransactionClient` types;
      the generated class no longer exported; the test helper's single-connection client through the
      factory (`max` pool option).
- [ ] Test: as the app login, `tx.user.findUnique({ where: { id } })` and `tx.user.update(…)`
      work (fail before: permission denied); the owner reads the hash with `omit: { passwordHash:
false }`.
- [ ] Typecheck the workspace; fix the call sites TypeScript reports. Commit.

### Task 3: The password login (API)

- [ ] Unit test `password.service.spec.ts`: `loginDigest` equals `sha256(hash)` for a real
      `hash()` output; a wrong password gives another digest; malformed, other algorithm, other
      version, over-the-ceiling parameters and `null` all give the dummy path (and still hash once).
- [ ] API e2e: password login still works (existing `password-set`/`password` specs); add a
      spec that the login's database calls never return a digest (the response of
      `auth_find_user_for_login` for a staff user has no 43-character tail).
- [ ] Code: `findUserForLogin` returns `password_params`; `passwordMatches(prisma, userId, digest)`
      in `login-lookup.ts`; `AuthService.loginWithPassword` uses both. Commit.

### Task 4: `hasPassword` (API)

- [ ] The existing `GET /me/password` tests (before and after setting a password) are the failing
      tests once the column is hidden; change `status()` to `auth_my_password_is_set()`. Commit.

### Task 5: Seed, harness and tests

- [ ] The demo seed's per-user update (as the app login) works with the omit (checked by
      `demo-devices.test.ts`, which runs the seed's code against the test database, and in CI by the
      Playwright seed).
- [ ] API tests that read `passwordHash` read it through the owner login. Commit.

### Task 6: Docs

- [ ] database.md (users: SELECT by column, the new functions, "a new `users` column needs a
      GRANT SELECT"), auth.md (how a password is checked), decisions-pending (P1-J built, P1-J1…).

### Task 7: Gates, review, PR

- [ ] lint, typecheck, format:check, tests package by package, build (Playwright in CI).
- [ ] Review subagent (database security). PR. CI green. Not merged.

## Risks

- **Merging with P2** (institute profile, files): P2 also adds migrations and touches
  `schema-safety.test.ts` and `database.md`. This PR's migration is dated first; merge it first.
- **A missed full-row read** would fail with "permission denied" rather than leak: the omit and
  the typed client make that unlikely, and the API suite covers every `users` read.
- **Existing local hashes** keep working (same format). Nothing to migrate.

## Not in this plan

- The platform admins' hashes (P1-J6).
- Rate-limiting the remaining yes/no oracle inside the database (P1-J1): the API's login limits
  already apply to the real login path.

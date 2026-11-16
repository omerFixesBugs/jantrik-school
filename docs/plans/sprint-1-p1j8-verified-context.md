# Sprint 1, P1-J8: a verified request context (implementation plan)

**Status: written and built during the unattended day run of 2026-11-17, for the owner's review
together with the PR.** "Changed while building" below lists where the build departed from the
first version of this plan. The owner asked for P1-J8 to be closed "with the option that closes it
most completely without weakening anything", planned here, built, and reviewed before P3. Nothing
is merged by Claude. The follow-up it answers is P1-J8 in
[decisions-pending.md](../decisions-pending.md); the previous step is
[sprint-1-p1j-password-hash.md](sprint-1-p1j-password-hash.md) (#16).

> **For agentic workers:** one implementer, then a database-security review subagent run by the
> coordinator. Steps use checkbox (`- [ ]`) syntax.

## Changed while building

- **`auth_context_key()` is for `jantrik_login_app` only;** the owner (seed, tests) reads the
  table directly, which it owns (a grant to the old owner does not survive the ownership change).
- **`app_verified_context()` is not runnable by PUBLIC** (schema-safety refuses that for every
  definer function): it is granted to the roles whose queries meet a policy (`jantrik_app`, the
  owner, `jantrik_search`, `jantrik_platform`, `jantrik_ingest`).
- **No format check before the MAC:** a regular expression cost about 30 µs a call (the whole check
  122 µs). The MAC is checked first over the raw text, nothing is cast before it passes, and
  nothing in the check can raise on a malformed value: about 38 µs a check.
- **`tenant_modules.provisioning_only`** read its own table in a subquery; with the wrapped call in
  that table's own policy PostgreSQL refused it as "infinite recursion detected in policy"
  (42P17). Its check moved into `app_tenant_has_modules()` (STABLE plpgsql, invoker).
- **`tenantClient` kept:** each model call now runs in its own `withTenant` (about 20 test uses).
- **The key is not only loaded at start-up:** CI's Playwright starts the API before its global
  setup migrates (and resets) `jantrik_e2e`, so the start-up load failed, and a reset would have
  made a new key under the running API. Now production still refuses to start without the key,
  development and tests log an error and load it on first use, and every signed transaction
  compares the database's key fingerprint (`app_context_key_id()`, one-way) in the round trip it
  already makes and reloads a changed key once (P1-J8h). Rotation needs no restart any more.
- **The DB tests register the key source in `helpers.ts`**, not a Vitest setup file (a setup file
  loads the package before `client-options.test.ts` mocks the adapter).

## Changed after the review (round 1)

- **No TEMP for the runtime logins** (the precondition the design relies on): the migration and
  the dev init revoke TEMPORARY on the database from PUBLIC; production refuses to start with a
  `DATABASE_URL` login that has it, elsewhere a warning; the request path's SQL is
  schema-qualified. The review planted a temporary view `tenants` through an injection and the
  victim's next request on the same connection ran it in the victim's signed context.
- **The roles and modules caches have a new key generation**, and the upgrade stops the API and
  the worker before `migrate` (an old API in between cached empty roles and modules).
- **Signed identities from rows:** `student_imports.created_by_id` pinned (column grant and a
  trigger); invitations checked before signing the URL's institute.
- **The HMAC pads are derived by a trigger**, so rotation is one UPDATE.
- **The wrapped-call guard** catches more forms and also scans views, defaults and CHECKs.
- **Planner estimates** with an InitPlan parameter: measured on a skewed dataset (Performance).

## Goal

No SQL that runs as `jantrik_app` can change **who** it runs as or **which institute** it runs
in. Today both come from two settings, `app.tenant_id` and `app.user_id`, which any statement in
the transaction can overwrite with `set_config`. After this change the database only believes a
context the API signed for that very transaction.

## The threat (what P1-J8 recorded)

An SQL injection in any ordinary request (a raw query built from user input, now or in a future
change) runs as `jantrik_app` inside the request's transaction. Today it can:

1. `set_config('app.user_id', <victim>, true)` and then, through the `users_update_self` policy
   and `jantrik_app`'s column grant, `UPDATE users SET password_hash = <its own argon2 hash>` for
   the victim, then sign in as the victim with a password it chose;
2. insert a session and a refresh token for the victim (`session_owner` policies,
   `user_id = app.user_id`), then refresh as the victim;
3. read the victim's refresh token hashes or other user-owned rows;
4. `set_config('app.tenant_id', <other institute>, true)` and read or write that institute's
   rows (every tenant policy), including inserting an OWNER membership for itself there, which
   takes over the institute;
5. learn one bit per person (has a password or not) through `auth_my_password_is_set()` (P1-J2).

P1-J (#16) stopped the reading of password hashes. It did not stop 1–5: they need no hash.

## Options considered

| Option                                                                                                                                                           | Closes          | Cost                                                                  | Verdict                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A. Writes of `users.password_hash`, `sessions` and `refresh_tokens` only through definer functions on a separate login                                           | 1, 2 (3 partly) | every session and password write moves to another pool                | Leaves 4: an injection still becomes OWNER of any institute through `memberships`, and reads any institute's data |
| B. Those writes through definer functions that check a server-side secret                                                                                        | 1, 2            | as A, plus a secret handed to every call                              | Same gap as A                                                                                                     |
| **C. A verified context: the API signs (tenant, user, this transaction) and `app_current_tenant_id()` / `app_current_user_id()` believe only a valid signature** | **1–5**         | one migration, one helper (`withContext`), the key loaded at start-up | **Chosen**                                                                                                        |
| D. One database role per institute (`SET ROLE`)                                                                                                                  | 4               | thousands of roles, a pool per role                                   | Not workable                                                                                                      |

C closes every path above, because every policy and every definer function already takes the
tenant and the user from those two functions only (docs/database.md → "Never accept a tenant id
as a parameter"). With C, an injection can do only what its own signed-in person could already
do through RLS, in its own institute. A and B could be added on top, but with C they protect
nothing more against `set_config` (an injection can only write its own password and its own
sessions, which it can do through the API anyway).

## Design

### The key

- `app_context_key` (one row, `id = 1`): `key` (48 random bytes), `inner_pad` and `outer_pad`
  (the key XOR the HMAC pads, 64 bytes each, so verification needs only the built-in `sha256()`;
  pgcrypto is not installed and stays so), `created_at`.
- **Generated inside the migration**, from three `gen_random_uuid()` values (`pg_strong_random`,
  122 random bits each, 366 in all). The migration file holds no secret; each database has its own
  key. A restore keeps it (it is in the dump, like every other row).
- Owned by `jantrik_owner`; `REVOKE ALL … FROM PUBLIC`; `SELECT` for `jantrik_auth` only (the
  owner of the definer functions below). `jantrik_app`, `jantrik_platform_app`,
  `jantrik_ingest_app` and `jantrik_login_app` have no privilege on it.
- **No new role and no new env var:** the owner needs no setup step beyond #16's.

### Reading the key: `auth_context_key()`

`SECURITY DEFINER`, owner `jantrik_auth`, returns the key. `EXECUTE` for **`jantrik_login_app`**
(#16's dedicated login, which no ordinary request uses), nobody else. `REVOKE … FROM PUBLIC`. The
seed and the tests read the table as its owner.

- **API and worker:** `LoginPrismaService` (constructed in both, AppModule → AuthModule) registers
  itself as the key's source in its constructor and loads the key in `onModuleInit`, after its
  privilege check: no key, no start (fail closed). login-isolation.spec.ts still holds: no second
  client on `DATABASE_LOGIN_URL`.
- **Seed (`pnpm db:seed`, Playwright's global setup), test helpers:** the owner client
  (`DATABASE_MIGRATION_URL` / `*_TEST`), which they already have.
- **The device receiver** never opens a tenant context (its `ingest_*` functions take the device
  serial) and gets nothing new.

### Signing: `withContext` (packages/db)

Same signatures (`withContext`, `withTenant`), so no call site changes:

```
BEGIN
SELECT pg_backend_pid()::text, (extract(epoch FROM now()) * 1000000)::bigint::text   -- 1 round trip
SELECT set_config('app.context', $1, true)                                            -- bound parameter
   $1 = 'v1:<tenant uuid or empty>:<user uuid or empty>:<pid>:<µs>:<hex HMAC-SHA256(key, everything before)>'
… fn(tx) …
COMMIT
```

Two round trips, as today when both tenant and user are set (one more than today for a
tenant-only or user-only context). The key comes from a per-process source
(`setRequestContextKeySource(load)`, memoised; `requestContextKeyReady()` loads it eagerly); a
context asked for before any source is registered throws a clear error.

`tenantClient` (P1-J8f): it ran each model call as a batch transaction, which cannot read the pid
and transaction start first; each model call now runs in its own `withTenant`.

### Verifying: the context functions

- `app_verified_context(OUT tenant_id uuid, OUT user_id uuid)`: `SECURITY DEFINER`, owner
  `jantrik_auth`, `STABLE`, `PARALLEL RESTRICTED` (it compares `pg_backend_pid()`, which differs in
  a parallel worker), `search_path = pg_catalog, public, pg_temp`, the key table schema-qualified.
  - `app.context` unset or `''` → `(NULL, NULL)`: no context, nothing visible (as today).
  - Otherwise it must have six parts, version `v1`, a correct HMAC over the first five (checked
    first, over the raw text: nothing is cast before it passes), and name **this** backend's pid
    and **this** transaction's start. Anything else → `RAISE … USING ERRCODE =
'insufficient_privilege'` (42501), one message for every reason: fail closed and loud.
  - The MAC is compared as `sha256(given hex) = sha256(expected hex)`, so the comparison time
    does not depend on how many leading characters match.
- `app_current_tenant_id()` / `app_current_user_id()` keep their names, owners and grants
  (`EXECUTE` for PUBLIC, as today); they become `SELECT (app_verified_context()).tenant_id`
  (`.user_id`), `STABLE`, `PARALLEL RESTRICTED`. So every policy and function that calls them now
  gets the verified value.
- `app.tenant_id` and `app.user_id` are ignored from now on.

Why binding to the pid and the transaction start: a context string that leaks (a log, an error
message) is useless anywhere else; inside its own transaction it only grants what the request
already had. A backend cannot start two transactions in the same microsecond.

### Once per statement, not once per row

Before, the functions were plain SQL and PostgreSQL inlined them into a constant. A definer
function is never inlined, so `tenant_id = app_current_tenant_id()` in a policy would verify the
HMAC for every row a sequential scan or a filter looks at. The migration therefore rewrites
**every policy** to call the functions as scalar subqueries, `(SELECT app_current_tenant_id())`,
which PostgreSQL runs once per statement (an InitPlan) and still uses as an index condition.

- Done with a loop over `pg_policy` (`pg_get_expr`, a regular expression, `ALTER POLICY`),
  idempotent: already wrapped calls are kept as they are, never wrapped twice. 76 of the 124
  policies change (the others do not call the functions).
- The four definer functions that call them (`app_find_or_create_user`,
  `auth_list_my_memberships`, `auth_my_password_is_set`, `search_student_ids`) are recreated with
  wrapped calls (bodies otherwise unchanged).
- The API's raw SQL that calls them in a `WHERE` (request-transaction.service.ts) is wrapped too;
  the others call them once per statement already (advisory locks, single-row inserts).
- **Guard:** schema-safety.test.ts fails if any policy or public function calls either function
  unwrapped. docs/database.md's new-table checklist and the add-tenant-table skill show the
  wrapped form.

## The function audit (definer functions `jantrik_app` may run)

| Function                                        | Parameters     | Could it act for someone else?                                                                                                                              | Verdict                                   |
| ----------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `app_find_or_create_user(phone, name, name_bn)` | a phone        | Creates a user for a new phone, or returns the id of the existing one; never changes an existing user. Needs a (now verified) tenant                        | Safe; wrapped call                        |
| `auth_find_refresh_token(token_hash)`           | a token hash   | Returns the session of a refresh token by its hash. Hashes of other people's tokens are now unreadable (the `session_owner` policies use the verified user) | Safe                                      |
| `auth_find_user_for_login(phone, email)`        | phone or email | Returns id, name and locale (P1-J1). Knowing an id no longer helps: the context cannot be set to it                                                         | Safe (an id is not a credential any more) |
| `auth_list_my_memberships()`                    | none           | Uses the verified user                                                                                                                                      | Safe; wrapped call                        |
| `auth_my_password_is_set()`                     | none           | Uses the verified user: P1-J2's one-bit leak is closed                                                                                                      | Safe; wrapped call                        |
| `auth_resolve_tenant(slug)`                     | a slug         | Returns public institute data (name, status, locale)                                                                                                        | Safe                                      |
| `search_student_ids(term, phone, limit)`        | search terms   | Filters by the verified tenant                                                                                                                              | Safe; wrapped call                        |
| `app_verified_context()` (new)                  | none           | Returns the caller's own verified context                                                                                                                   | Safe                                      |
| `auth_context_key()` (new)                      | none           | Not executable by `jantrik_app`                                                                                                                             | —                                         |

Column grants checked too: `jantrik_app` may update only `name_bn`, `locale`, `color_scheme`,
`password_hash`, `password_changed_at` and `updated_at` of `users`, and only through
`users_update_self`, now the verified user. It cannot change a phone or an email at all, so the
"change the victim's phone, then sign in by OTP" path never existed.

## Still open after this (recorded, not built)

- **P1-J10, inside one's own institute:** RLS isolates institutes, not roles. An injection in a
  teacher's or a guardian's request can still write any row of its own institute that
  `jantrik_app` may write, e.g. insert an OWNER membership for itself in `memberships`, or change
  marks. That needs no `set_config` and is not P1-J8. Options for the owner in decisions-pending.
- **The platform context** (`app.platform_session` holds a session token's hash, read by the
  platform functions only) runs on its own login with no institute traffic (P1-J6); unchanged.

## Upgrade

1. **Locally:** `pnpm db:migrate`, then restart `pnpm dev`. No new role, no new `.env` line
   (`DATABASE_LOGIN_URL` from #16 is enough).
2. **Server:** `migrate`, then restart **api and worker together** (docs/deploy.md → Upgrades).
   Between the two, the old processes set the old settings, which the new functions ignore: their
   requests see no rows and fail. A failed refresh is retried; nobody is signed out.
3. **Rollback:** the migration's down path is "restore the previous function bodies": recorded in
   the migration's comment; the policies' wrapped form is correct for both versions.
4. **Key rotation** (not built, documented): `UPDATE app_context_key …` as the owner, then restart
   api and worker; requests between the two fail.

## Tests

Failing first where it can (the attack tests fail on the integration branch):

- **packages/db/test/request-context.test.ts (new):** with user A's valid context, an injection's
  `set_config` of `app.user_id` / `app.tenant_id` (old settings) changes nothing; a forged, tampered
  (one flipped hex digit, another user, another tenant), truncated, upper-cased or extra-part
  `app.context` raises 42501; a context copied into a later transaction on the same connection, or
  into another connection, raises; no context means no rows. And the P1-J8 attacks end to end:
  A cannot update B's `password_hash`, insert or update a session or refresh token for B, read B's
  refresh token hashes, read or write institute B's rows, or insert a membership in institute B.
- **Privileges:** `jantrik_app`, the platform and receiver logins cannot read `app_context_key`
  or run `auth_context_key()`; `jantrik_login_app` and the owner can; the login's pinned function
  list grows by exactly one.
- **schema-safety.test.ts:** no unwrapped call in any policy or public function.
- **API:** `LoginPrismaService` registers the source and refuses to start without the key; the
  harness's requests work (every API e2e spec), the login isolation spec still holds.
- **Every existing RLS suite** still passes; tests that set the old settings by hand change
  (devices-rls.test.ts, no-context.test.ts, platform-isolation.spec.ts).
- **The restore check** (deploy/backup/restore-check.sh, CI's backup job) signs its own context as
  the superuser.

## Performance

Micro-benchmark on the scratch database (scratchpad `bench-context.ts`: one tenant, 300 students;
Windows + Docker, so each round trip costs about 1.5 ms). Before (integration/sprint-1):

| Transaction                     | Before       | After                                                 |
| ------------------------------- | ------------ | ----------------------------------------------------- |
| `student.count`                 | 6.0–6.4 ms   | 7.4–8.1 ms (one more round trip: tenant-only context) |
| 300 students with enrolments    | 61–65 ms     | 63.2–64.4 ms                                          |
| 10 statements                   | 25.9–26.1 ms | 26.7–27.9 ms                                          |
| users list (policy with EXISTS) | 7.4–7.6 ms   | 8.1–8.3 ms (one run 12.0, noise)                      |

One check: 38 µs (2,000 in one statement: 77 ms), against 122 µs for the first version with a
format regex. A tenant-and-person context (every authenticated request) needs no more round trips
than before; a tenant-only or person-only one (jobs, login steps) needs one more.

Plus the existing budgets (the 600-student publish, fee reports) in the full API suite.

## Decisions taken in this plan (the owner reviews them with the PR)

- **P1-J8a** Option C, the verified context (table above).
- **P1-J8b** The key lives in the database, generated by the migration; the API reads it through
  the login login (`jantrik_login_app`), the seed and tests through the owner. No env var.
- **P1-J8c** A bad context raises 42501 instead of meaning "no context".
- **P1-J8d** Bound to the backend pid and the transaction start, so a leaked string is useless.
- **P1-J8e** Every policy rewritten to the wrapped form in the same migration; guarded by a test.
- **P1-J8f** `tenantClient` kept, one `withTenant` per model call.
- **P1-J8g** `app_verified_context()` granted to the roles that meet policies, not PUBLIC.
- **P1-J8h** Start-up refuses without the key in production only; a changed key is noticed by its
  fingerprint and reloaded. No key rotation command; documented SQL (database.md → The request
  context).
- **P1-J10** (follow-up) role-level limits inside an institute.

## Files

- `packages/db/prisma/migrations/20261117000000_verified_request_context/migration.sql`
- `packages/db/src/tenancy/context.ts` (signing, the key source; `tenantClient` per call)
- `packages/db/src/seed/index.ts`, test helpers / setup (key source)
- `apps/api/src/auth/login-prisma.service.ts` (+ spec), `apps/api/src/tenancy/request-transaction.service.ts`
- `deploy/backup/restore-check.sh`
- tests listed above; docs: auth.md, database.md, deploy.md, decisions-pending.md, README.md,
  `.claude/skills/add-tenant-table/SKILL.md`

## Tasks

- [x] 1. This plan.
- [x] 2. Migration: key table, `auth_context_key`, `app_verified_context`, the two functions, the
      policy rewrite, the four definer functions.
- [x] 3. `withContext` signing, the key source, `tenantClient` per call; seed and test helpers.
- [x] 4. The attack and privilege tests; existing tests updated.
- [x] 5. API: `LoginPrismaService` loads the key; raw SQL wrapped; API tests.
- [x] 6. Restore check.
- [x] 7. Benchmark after; docs; decisions-pending.
- [x] 8. Gates one at a time, push, draft PR, CI.

## Risks

- **A context opened before the key is loaded** (a module's start-up code): the source is
  registered in a constructor and awaited by `withContext`, so order does not matter; a missing
  source throws loudly.
- **A policy written later without the wrapper** still works, only slower: the schema test fails.
- **Statement cost:** one HMAC check per statement per function used (an InitPlan each); measured
  above.
- **Upgrade window:** see Upgrade.

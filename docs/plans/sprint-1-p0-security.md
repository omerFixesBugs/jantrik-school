# Sprint 1, P0: security follow-ups (implementation plan)

**Status: plan, waiting for the owner's approval (written 2026-11-14).** It touches auth (the
platform guard), the database logins, Redis and the deployment, so it needs approval before any
code (CLAUDE.md). The sprint plan is [sprint-1.md](sprint-1.md) → P0. "Added in this plan" below
lists four points the sprint plan did not settle.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (approved rhythm:
> one implementer, one review subagent at the end of the phase). Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** close the four security items deploy.md leaves to the owner:

- `/platform/*` answers only the platform's own origin;
- no service starts with a database login that is a superuser or bypasses RLS;
- the device receiver's queries stop after 5 s;
- the receiver's Redis login reaches only its own keys and queue.

**Architecture:**

- **Platform origin:** a pure `isPlatformOrigin()` function, checked first in `PlatformAuthGuard`
  for every platform route.
- **Login checks:** one SQL check of the login's privileges in `packages/db`, run at start-up by
  the API, platform and receiver Prisma services. They share one retry runner, extracted from
  today's receiver check.
- **Receiver timeout:** `statement_timeout` is sent by the receiver's pool and set on its role.
  Its start-up check refuses to start without it.
- **Redis:** an ACL user defined from one rules file, used by the compose file and by the test that
  proves the rules.

**Tech stack:** NestJS guards and lifecycle hooks, Prisma with `@prisma/adapter-pg` (pg 8.23,
which sends `statement_timeout` in the startup packet), ioredis 5.11, BullMQ 6.3, Redis 7 ACLs and
Vitest.

**Spec:** [sprint-1.md](sprint-1.md) → "P0: Security follow-ups", decisions S27 and #79 (5 s,
the owner's choice). Also [deploy.md](../deploy.md) → "What needs the owner" and
[decisions-pending.md](../decisions-pending.md) → Deployment readiness → "Recorded for the owner,
not built".

**Branch:** `feature/sprint-1-p0-security`, from `feature/sprint-1-admission`, so the two plan
documents travel in P0's PR. This is a small exception to S2's "from `main`" (A3 below).

## Global constraints

- Platform origins:
  - **Env:** `PLATFORM_ORIGINS`, comma-separated. Each entry is normalised with
    `new URL(entry).origin`; an entry that is not a URL is refused at start.
  - **Default:** `http://localhost:3000`, outside production only.
  - **Production:** the variable must be set, each entry must pass `unsafeOrigin()` (https, not
    local), and each entry must also be in `CORS_ORIGINS`.
- The refusal is `403` with code `PLATFORM_ORIGIN_REFUSED`. It applies to both
  `@PlatformRoute('login')` and `('session')` routes, and runs before the client-header check, the
  rate limiter and any database lookup.
- In development with `DEV_LAN=true`, a private-LAN origin (`isPrivateLanOrigin`) is accepted, as
  CORS does.
- A login is refused when any of these is true:
  - it is a superuser, or has BYPASSRLS;
  - it can become (`pg_has_role(…, 'MEMBER')`) another role that is a superuser or has BYPASSRLS;
  - it can become one of `pg_read_all_data`, `pg_write_all_data`, `pg_read_server_files`,
    `pg_write_server_files`, `pg_execute_server_program` (A1).
- Start-up checks retry with the receiver's waits: 1, 2, 4 and 8 s, then 15 s eleven times, about
  3 minutes. Each check may take 10 s. A failing check after the last wait refuses the start. A
  wrong answer refuses it at once, with no retry.
- Receiver timeout:
  - `statement_timeout` is exactly `5000` ms in `INGEST_POOL`;
  - the receiver's start-up check requires `current_setting('statement_timeout') = '5s'`;
  - the role scripts set `ALTER ROLE jantrik_ingest_app SET statement_timeout = '5s'`.
- Redis:
  - the user is `jantrik_ingest`, its password `REDIS_INGEST_PASSWORD`;
  - its keys are `~ingest:*`, `~rl:ingest-*` and `~<QUEUE_PREFIX>:devices:*`;
  - no Pub/Sub channels; the commands come from one rules file, `deploy/redis/ingest-user.acl`.
- Files and secrets:
  - `.env` is never edited.
  - New variables go into `.env.example` (`PLATFORM_ORIGINS`, commented with its default) and
    `deploy/.env.prod.example` (`REDIS_INGEST_PASSWORD=CHANGE_ME_openssl_rand_hex_24`).
  - The CI job env gains `DATABASE_SUPERUSER_URL_TEST`.
- Messages and logs:
  - Messages name the variable and the login, never a password.
  - Logs carry error names and codes only (`errorLabel`), as today.

## Review focus

Each item has a test in the task named.

1. **The institute app's origin calling `/platform/*`.** It is in `CORS_ORIGINS` (so the
   browser's preflight passes), but not in `PLATFORM_ORIGINS`. Expected: 403. This is the case the
   check exists for: an XSS in the institute app using the platform cookie, which is same-site.
   (Task 5)
2. **The API starting while Postgres is still starting** (`pnpm dev` right after
   `docker compose up`, or a server reboot). Expected: it waits and retries, then starts. It never
   starts unchecked, and never refuses a login it could not check. (Tasks 2–3)
3. **A device upload cut by the 5 s limit.** Expected: nothing of that upload is stored (one
   statement, rolled back). The device gets 500 and resends, and the resend stores every punch
   once. (Task 4)
4. **A job queued by the receiver under its ACL user, processed by the worker under the full
   user.** Expected: the worker sees an ordinary waiting job. The ACL must not break the job's
   later life. (Task 6)
5. **Production settings slightly wrong:**
   - `PLATFORM_ORIGINS` missing, http, or not in `CORS_ORIGINS`;
   - the receiver's `REDIS_URL` without the `jantrik_ingest` user.

   Expected: refused at start with a message naming the variable. Development and Playwright
   defaults keep working. (Tasks 5–6)

## Added in this plan (the owner approves these with the plan)

- **A1. More than superuser and BYPASSRLS.** The check also refuses a login that can become
  `pg_read_all_data`, `pg_write_all_data` or the server file and program roles. They pass every
  grant this design relies on (platform tables, receiver functions). It costs one line of SQL.
- **A2. Fail closed means the API waits for the database.**
  - The API and the worker now check their login at start: up to about 3 minutes of retries, then
    they exit.
  - Before, they started and only requests failed.
  - In development, `pnpm dev` without Docker running now exits after about 3 minutes, with a
    message that names `DATABASE_URL`.
- **A3. Branch from the plan branch** (above). The alternative is a docs-only PR first, then P0
  from `main`.
- **A4. The Redis ACL test adds `+select`.** The API tests use Redis database 1, which needs
  `SELECT`. The production rules have no `select` (asserted). Production `REDIS_URL`s name no
  database.

## Files

| File                                                                                                | Change                                                                        |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/db/src/login-privileges.ts`                                                               | new: `readLoginPrivileges`, `loginPrivilegeProblems`                          |
| `packages/db/src/index.ts`                                                                          | export it; `PoolOptions.statement_timeout`                                    |
| `packages/db/test/login-privileges.test.ts`                                                         | new                                                                           |
| `packages/db/test/env.ts`                                                                           | `superuserUrl()` (throws only when called)                                    |
| `packages/db/test/client-options.test.ts`                                                           | `statement_timeout` passed and enforced                                       |
| `packages/db/test/ingest-functions.test.ts`                                                         | an upload cut by the timeout stores nothing; the resend stores all            |
| `apps/api/src/common/startup-check.ts` (+ `.spec.ts`)                                               | new: `runStartupCheck`, `STARTUP_RETRY_DELAYS_MS`, `STARTUP_CHECK_TIMEOUT_MS` |
| `apps/api/src/ingest/ingest-prisma.service.ts` (+ spec)                                             | uses the runner; timeout in the pool and the check; privileges                |
| `apps/api/src/prisma/prisma.service.ts` (+ new spec)                                                | `onModuleInit`: privilege check                                               |
| `apps/api/src/platform/platform-prisma.service.ts` (+ spec)                                         | privilege check before the existing role check                                |
| `apps/api/src/platform/platform-origin.ts` (+ spec)                                                 | new: `isPlatformOrigin`                                                       |
| `apps/api/src/platform/platform-auth.guard.ts`                                                      | the origin check                                                              |
| `apps/api/src/config/env.ts`, `production-env.ts` (+ spec)                                          | `PLATFORM_ORIGINS`; receiver Redis user rule                                  |
| `apps/api/test/support/platform.ts`, `platform-auth.e2e-spec.ts`, `platform-institutes.e2e-spec.ts` | send `Origin`; new cases                                                      |
| `apps/api/test/redis-acl.e2e-spec.ts`                                                               | new: the rules against a real Redis                                           |
| `deploy/redis/ingest-user.acl`, `deploy/redis/start-redis.sh`, `deploy/redis/check-ingest-acl.sh`   | new                                                                           |
| `deploy/docker-compose.prod.yml`, `deploy/.env.prod.example`                                        | Redis command and user; receiver `REDIS_URL`; `PLATFORM_ORIGINS`              |
| `deploy/postgres/create-roles.sh`, `docker/postgres/init/01-roles.sh`                               | `ALTER ROLE jantrik_ingest_app SET statement_timeout = '5s'`                  |
| `.github/workflows/ci.yml`                                                                          | `DATABASE_SUPERUSER_URL_TEST`; Redis ACL step; shellcheck glob                |
| `.env.example`, docs (auth, platform, database, deploy, devices, decisions-pending)                 | Task 7                                                                        |

---

### Task 1: The login privilege check (`packages/db`)

**Files:**

- Create: `packages/db/src/login-privileges.ts`
- Create: `packages/db/test/login-privileges.test.ts`
- Modify: `packages/db/src/index.ts`, `packages/db/test/env.ts`, `.github/workflows/ci.yml` (top
  `env`: `DATABASE_SUPERUSER_URL_TEST: postgresql://postgres:postgres@localhost:5432/jantrik_test`)

**Interfaces:**

- Produces:
  - `interface LoginPrivileges { login: string; superuser: boolean; bypassRls: boolean; canBecome: string[] }`
  - `readLoginPrivileges(client: PrismaClient): Promise<LoginPrivileges>`
  - `loginPrivilegeProblems(p: LoginPrivileges): string[]`: plain reasons, empty when the login is
    safe, e.g. `['is a superuser', 'has BYPASSRLS', 'can become postgres']`
  - `PRIVILEGED_PREDEFINED_ROLES` (the five `pg_*` names of A1)

- [ ] **Step 1: Write the failing tests**

  The test creates its own roles as the superuser with random names and drops them in `afterAll`:
  `REVOKE CONNECT ON DATABASE jantrik_test FROM r; DROP ROLE r`.

```ts
describe('login privileges', () => {
  it('the runtime logins (app, platform, receiver) and the owner have none', async () => {
    for (const url of [APP_URL, PLATFORM_URL, INGEST_URL, OWNER_URL]) {
      const p = await withClient(url, readLoginPrivileges);
      expect(loginPrivilegeProblems(p)).toEqual([]);
    }
  });
  it('refuses the Postgres superuser', async () => {
    const p = await withClient(superuserUrl(), readLoginPrivileges);
    expect(p.superuser).toBe(true);
    expect(loginPrivilegeProblems(p)).toContain('is a superuser');
  });
  it('refuses a login with BYPASSRLS', async () => {
    const p = await withClient(await tempLogin('BYPASSRLS'), readLoginPrivileges);
    expect(loginPrivilegeProblems(p)).toEqual(['has BYPASSRLS']);
  });
  it('refuses a login that can become a superuser role', async () => {
    const su = await tempRole('NOLOGIN SUPERUSER');
    const p = await withClient(await tempLogin('', { member: su }), readLoginPrivileges);
    expect(loginPrivilegeProblems(p)).toEqual([`can become ${su}`]);
  });
  it('refuses a login that can become pg_read_all_data', async () => {
    const p = await withClient(
      await tempLogin('', { member: 'pg_read_all_data' }),
      readLoginPrivileges,
    );
    expect(loginPrivilegeProblems(p)).toEqual(['can become pg_read_all_data']);
  });
});
```

`withClient(url, fn)` creates a client, runs `fn`, then disconnects. `tempLogin(attrs, {member})`
runs, as the superuser:

- `CREATE ROLE <random> LOGIN <attrs> PASSWORD '<random>'`;
- `GRANT CONNECT ON DATABASE jantrik_test TO <role>`;
- `GRANT <member> TO <role>` when given.

It returns the role's URL. `superuserUrl()` in `env.ts` returns `DATABASE_SUPERUSER_URL_TEST`.
Without it, it builds the URL from `POSTGRES_USER` and `POSTGRES_PASSWORD` (in the root `.env`)
on `APP_URL`'s host and database. If neither is there, it throws "set
DATABASE_SUPERUSER_URL_TEST": it fails, it never skips.

- [ ] **Step 2: Run them and see them fail**

  Run: `pnpm --filter @jantrik/db exec vitest run test/login-privileges.test.ts`
  Expected: FAIL, `readLoginPrivileges` is not exported.

- [ ] **Step 3: Implement `readLoginPrivileges` and `loginPrivilegeProblems`**

  `readLoginPrivileges` is one query:

```sql
SELECT current_user AS login, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls,
       COALESCE(array_agg(o.rolname ORDER BY o.rolname)
                FILTER (WHERE o.rolname IS NOT NULL), '{}') AS can_become
  FROM pg_roles r
  LEFT JOIN pg_roles o
    ON o.rolname <> current_user
   AND (o.rolsuper OR o.rolbypassrls OR o.rolname = ANY (${PRIVILEGED_PREDEFINED_ROLES}))
   AND pg_has_role(current_user, o.oid, 'MEMBER')
 WHERE r.rolname = current_user
 GROUP BY r.rolsuper, r.rolbypassrls
```

`loginPrivilegeProblems` lists `is a superuser` when `superuser` is true. Only when it is not a
superuser, it lists `has BYPASSRLS` and `can become <role>` for each entry. A superuser can
become every role, so the list would be noise.

- [ ] **Step 4: Run the tests and see them pass**, the same command. Expected: PASS (5 tests).

- [ ] **Step 5: Commit** `packages/db/src/login-privileges.ts`, `index.ts`, `test/env.ts`,
      `test/login-privileges.test.ts` and `ci.yml`, with the message: "A check of what a database
      login can do: superuser, BYPASSRLS, or able to become such a role or a pg_read/write_all_data
      or server-file role (sprint 1, P0)".

### Task 2: One start-up check runner (extracted from the receiver)

**Files:**

- Create: `apps/api/src/common/startup-check.ts`, `apps/api/src/common/startup-check.spec.ts`
- Modify: `apps/api/src/ingest/ingest-prisma.service.ts` (its retry loop moves; behaviour
  unchanged)

**Interfaces:**

- Produces:

```ts
export const STARTUP_CHECK_TIMEOUT_MS = 10_000;
export const STARTUP_RETRY_DELAYS_MS: readonly number[]; // [1000, 2000, 4000, 8000, 15000 × 11]
export interface StartupCheck<T> {
  run: () => Promise<T>;
  /** true to start; a string refuses the start at once with that message (never retried). */
  verdict: (answer: T) => true | string;
  retryDelaysMs: readonly number[];
  checkTimeoutMs: number;
  logger: { warn(m: string): void; log(m: string): void };
  /** e.g. "the device receiver's database login (DATABASE_INGEST_URL)" */
  what: string;
  /** e.g. "The receiver does not start unchecked." */
  unchecked: string;
  /** What may be logged about a failure (errorLabel + the adapter's kind). */
  label: (error: unknown) => string;
}
export function runStartupCheck<T>(check: StartupCheck<T>): Promise<void>;
```

- [ ] **Step 1: Write `startup-check.spec.ts`** with the receiver spec's cases, made generic:
  - it starts on `true`;
  - a string verdict throws that string at once;
  - it retries on errors with the given delays;
  - it throws `Could not check <what>: <label>. <unchecked>` after the last wait;
  - a check with no answer counts as failed after `checkTimeoutMs`;
  - a late rejection after the timeout is ignored;
  - the default delays add up to between 170 and 190 s.
- [ ] **Step 2: Run it.** `pnpm --filter @jantrik/api exec vitest run src/common/startup-check.spec.ts`.
      Expected: FAIL (no module).
- [ ] **Step 3: Move the loop and the timeout race** from `IngestPrismaService.onModuleInit` and
      `check()` into `runStartupCheck`. `IngestPrismaService.onModuleInit` becomes one call with its
      current texts, so every message stays word for word.
- [ ] **Step 4: Run both specs.** Run `vitest run src/common/startup-check.spec.ts
src/ingest/ingest-prisma.service.spec.ts`. Expected: PASS, with `ingest-prisma.service.spec.ts`
      **unmodified**: the refactor's safety net.
- [ ] **Step 5: Commit**: "One start-up check runner for the database logins, taken from the
      receiver's (behaviour unchanged)".

### Task 3: The API, worker and platform logins checked at start

**Files:**

- Modify: `apps/api/src/prisma/prisma.service.ts`, `apps/api/src/platform/platform-prisma.service.ts`
- Create: `apps/api/src/prisma/prisma.service.spec.ts`
- Modify: `apps/api/src/platform/platform-prisma.service.spec.ts`

**Interfaces:**

- Consumes: `readLoginPrivileges` and `loginPrivilegeProblems` (Task 1), `runStartupCheck`
  (Task 2).
- Produces: `PrismaService implements OnModuleInit`, with `retryDelaysMs` and `checkTimeoutMs` as
  public fields like the receiver's (tests set them to 0 and 50).

- [ ] **Step 1: Write the failing specs**

```ts
it('starts when the login has no privileges', async () => {
  await expect(service(SAFE).onModuleInit()).resolves.toBeUndefined();
});
it('refuses a superuser login at once, naming DATABASE_URL and the login, never retrying', async () => {
  const { s, queryRaw } = service({ ...SAFE, login: 'postgres', superuser: true });
  await expect(s.onModuleInit()).rejects.toThrow(/DATABASE_URL.*postgres.*is a superuser/);
  expect(queryRaw).toHaveBeenCalledTimes(1);
});
it('refuses a login that can become a BYPASSRLS role', async () => {
  await expect(service({ ...SAFE, canBecome: ['admin_bypass'] }).onModuleInit()).rejects.toThrow(
    /can become admin_bypass/,
  );
});
it('waits while the database is unreachable, then starts (review focus 2)', async () => {
  const { s } = service(unreachable(), unreachable(), SAFE);
  await expect(s.onModuleInit()).resolves.toBeUndefined();
});
it('refuses to start unchecked when the database never answers', async () => {
  await expect(
    service(unreachable(), unreachable(), unreachable(), unreachable()).onModuleInit(),
  ).rejects.toThrow(/DATABASE_URL.*does not start unchecked/);
});
```

`platform-prisma.service.spec.ts` gets the same five cases for `DATABASE_PLATFORM_URL`, plus one
more: after the privilege check passes, the existing role mix-up check still runs (a wrong
answer still throws "Database roles are mixed up").

- [ ] **Step 2: Run them.** Run `vitest run src/prisma src/platform/platform-prisma.service.spec.ts`.
      Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `PrismaService.onModuleInit` calls `runStartupCheck`:
    - `run`: `readLoginPrivileges(this.client)`;
    - `verdict`: `true` when there are no problems, otherwise
      `DATABASE_URL must use the app login (jantrik_app): ${login} ${problems.join(', ')}. See docs/database.md.`;
    - `what`: "the API's database login (DATABASE_URL)";
    - `unchecked`: "The API does not start unchecked.".
  - `PlatformPrismaService.onModuleInit` does the same for `DATABASE_PLATFORM_URL` first. Its
    existing check then runs as today (it still only warns on an error, since the privilege check
    has already proved the database answers).
- [ ] **Step 4: Run the specs, then the whole API suite.** Run
      `pnpm --filter @jantrik/api exec vitest run`. Expected: PASS. Every e2e spec builds the real
      `PrismaService` against `jantrik_app`, so the check runs in each.
- [ ] **Step 5: Commit**: "The API, the worker and the platform module refuse to start with a
      database login that is a superuser, bypasses RLS or can become such a role (sprint 1, P0)".

### Task 4: The receiver: 5 s statement timeout and the same privilege check

**Files:**

- Modify: `packages/db/src/index.ts` (`PoolOptions.statement_timeout?: number`, documented as "sent
  at connect, enforced by the server"), `packages/db/test/client-options.test.ts`,
  `packages/db/test/ingest-functions.test.ts`
- Modify: `apps/api/src/ingest/ingest-prisma.service.ts` and its spec
- Modify: `deploy/postgres/create-roles.sh`, `docker/postgres/init/01-roles.sh`

**Interfaces:**

- Consumes: `readLoginPrivileges` (Task 1) and `runStartupCheck` (Task 2).
- Produces: `INGEST_POOL.statement_timeout === 5000`. The start-up check row gains
  `statement_timeout: string`.

- [ ] **Step 1: Write the failing tests**

```ts
// client-options.test.ts
it('passes statement_timeout to node-postgres', () => {
  configs.length = 0;
  createPrismaClient('postgresql://u:p@127.0.0.1:1/x', { statement_timeout: 5000 });
  expect(configs).toEqual([
    { connectionString: 'postgresql://u:p@127.0.0.1:1/x', statement_timeout: 5000 },
  ]);
});
it('the server enforces it: a longer query is cancelled (57014)', async () => {
  const client = createPrismaClient(INGEST_URL, { statement_timeout: 200 });
  try {
    const [{ t }] = await client.$queryRaw<
      { t: string }[]
    >`SELECT current_setting('statement_timeout') AS t`;
    expect(t).toBe('200ms');
    await expect(client.$queryRaw`SELECT pg_sleep(1)`).rejects.toThrow(/57014|canceling statement/);
  } finally {
    await client.$disconnect();
  }
});

// ingest-functions.test.ts (review focus 3); `store` is the file's helper, given a client
it('an upload cut by the statement timeout stores nothing; sending it again decides every punch once', async () => {
  const rows = Array.from({ length: 50 }, (_, m) => burst(minuteAt(m), 200, 1000)).flat(); // 10 000 rows
  const slow = createPrismaClient(INGEST_URL, { statement_timeout: 50 });
  try {
    await expect(store(dev.serialNo, rows, { client: slow })).rejects.toThrow(
      /57014|canceling statement/,
    );
  } finally {
    await slow.$disconnect();
  }
  expect(await storedPunches(dev)).toBe(0);
  const [first] = await store(dev.serialNo, rows);
  expect(first!.duplicates).toBe(0);
  expect(first!.inserted + first!.held + first!.dropped).toBe(rows.length);
  const [again] = await store(dev.serialNo, rows);
  expect(again).toMatchObject({ inserted: 0, duplicates: first!.inserted + first!.held });
});

// ingest-prisma.service.spec.ts
it("builds the receiver's pool with a 5 s statement timeout (decision #79)", () => {
  expect(INGEST_POOL.statement_timeout).toBe(5000);
});
it('refuses to start, at once, when the login runs without the 5 s limit', async () => {
  await expect(service({ ...PASS, statement_timeout: '0' }).s.onModuleInit()).rejects.toThrow(
    /statement_timeout/,
  );
});
it('refuses a receiver login that can become a superuser role', async () => {
  await expect(
    service(PASS, { ...SAFE, canBecome: ['postgres'] }).s.onModuleInit(),
  ).rejects.toThrow(/DATABASE_INGEST_URL.*can become postgres/);
});
```

`store` and `burst` are the file's existing helpers:

- `store` gains an optional `client` (default: the receiver client);
- `minuteAt(m)` is a small helper that gives `'HH:MM'` for minute `m` after 08:00;
- `storedPunches(dev)` counts the device's rows as the owner, inside its institute's context.

The per-minute cap holds back or drops part of each 200-punch minute. So the test checks that
every row is decided once, not a fixed insert count. If the 10 000-row upload ever finishes
within 50 ms on CI, which is unlikely (about 2 s measured), lower the limit until the cut is
reliable. Never raise the row count past the function's 10 000 cap. The spec's `service()` helper now takes `(check, privileges?)`
pairs: each attempt answers the check query and then `readLoginPrivileges`. `PASS` gains
`statement_timeout: '5s'`.

- [ ] **Step 2: Run them.** Run
      `pnpm --filter @jantrik/db exec vitest run test/client-options.test.ts test/ingest-functions.test.ts`
      and `pnpm --filter @jantrik/api exec vitest run src/ingest`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `PoolOptions` gains `statement_timeout`, and `INGEST_POOL` gets `statement_timeout: 5_000`.
  - Its comment drops "Queries themselves have no time limit yet" and cites #79 as decided.
  - The check query adds `current_setting('statement_timeout') AS statement_timeout`. The verdict
    requires `'5s'` and no `loginPrivilegeProblems`.
  - Both role scripts add `ALTER ROLE jantrik_ingest_app SET statement_timeout = '5s';` after the
    role is created. In `create-roles.sh` it is idempotent, and it is applied on every run.
- [ ] **Step 4: Run the tests and see them pass**, the same commands. Expected: PASS.
- [ ] **Step 5: Commit**: "The device receiver's queries stop after 5 s (statement_timeout sent by
      its pool and set on its role; it refuses to start without it), and its login gets the same
      privilege check (decision #79, sprint 1 P0)".

### Task 5: `Origin` allowlist in `PlatformAuthGuard`

**Files:**

- Create: `apps/api/src/platform/platform-origin.ts`, `apps/api/src/platform/platform-origin.spec.ts`
- Modify: `apps/api/src/platform/platform-auth.guard.ts`, `apps/api/src/config/env.ts`,
  `apps/api/src/config/production-env.ts`, `apps/api/src/config/production-env.spec.ts`
- Modify: `apps/api/test/support/platform.ts` (`withHeaders` also sets
  `Origin: http://localhost:3000`), `apps/api/test/platform-auth.e2e-spec.ts`, and the raw platform
  requests in `apps/api/test/platform-institutes.e2e-spec.ts`
- Modify: `deploy/docker-compose.prod.yml` (`x-api-env`: `PLATFORM_ORIGINS: https://${PLATFORM_DOMAIN:?}`)

**Interfaces:**

- Produces:
  - `isPlatformOrigin(origin: string | undefined, env: Pick<Env, 'NODE_ENV' | 'DEV_LAN' | 'PLATFORM_ORIGINS'>): boolean`
  - `Env.PLATFORM_ORIGINS: string[]` (normalised origins)
  - `ApiProductionEnv.PLATFORM_ORIGINS`

- [ ] **Step 1: Write the failing tests**

```ts
// platform-origin.spec.ts
const env = {
  NODE_ENV: 'production',
  DEV_LAN: false,
  PLATFORM_ORIGINS: ['https://platform.jantrik.com.bd'],
} as const;
it('accepts only a listed origin, exactly', () => {
  expect(isPlatformOrigin('https://platform.jantrik.com.bd', env)).toBe(true);
  for (const o of [
    undefined,
    '',
    'null',
    'https://app.jantrik.com.bd',
    'http://platform.jantrik.com.bd',
    'https://platform.jantrik.com.bd.evil.example',
    'https://platform.jantrik.com.bd:8443',
  ]) {
    expect(isPlatformOrigin(o, env)).toBe(false);
  }
});
it('accepts a private-LAN origin only in development with DEV_LAN', () => {
  const lan = 'http://192.168.0.200:3000';
  expect(isPlatformOrigin(lan, { ...env, NODE_ENV: 'development', DEV_LAN: true })).toBe(true);
  expect(isPlatformOrigin(lan, { ...env, NODE_ENV: 'development', DEV_LAN: false })).toBe(false);
  expect(isPlatformOrigin(lan, { ...env, NODE_ENV: 'test', DEV_LAN: true })).toBe(false);
});

// platform-auth.e2e-spec.ts
it('refuses a platform login without an Origin: 403 PLATFORM_ORIGIN_REFUSED', async () => {
  const res = await http(h)
    .post('/platform/auth/login')
    .set('X-Jantrik-Client', PLATFORM_CLIENT)
    .send({ identifier: admin.phone, password: admin.password })
    .expect(403);
  expect(res.body.code).toBe('PLATFORM_ORIGIN_REFUSED');
});
it('refuses a session route from an unlisted origin even with a live cookie, before the session lookup', async () => {
  const { cookie } = await platformLogin(h, admin);
  await platform(h, cookie)
    .get('/platform/auth/me')
    .set('Origin', 'https://elsewhere.example')
    .expect(403);
  await platform(h, 'jantrik_ps=' + 'x'.repeat(40))
    .get('/platform/auth/me')
    .set('Origin', 'null')
    .expect(403); // 403, not 401
});
describe('the institute app is allowed for CORS but not for the platform (review focus 1)', () => {
  // process.env before createHarness, restored in afterAll:
  // CORS_ORIGINS=http://localhost:3000,http://app.test  PLATFORM_ORIGINS=http://localhost:3000
  it('refuses http://app.test on /platform/* and accepts http://localhost:3000', async () => {
    const { cookie } = await platformLogin(h2, admin2);
    await platform(h2, cookie)
      .get('/platform/auth/me')
      .set('Origin', 'http://app.test')
      .expect(403);
    await platform(h2, cookie).get('/platform/auth/me').expect(200);
  });
});

// production-env.spec.ts (review focus 5); `api` gains PLATFORM_ORIGINS: 'https://platform.jantrik.com.bd'
it('requires PLATFORM_ORIGINS in production: https, not local, and also in CORS_ORIGINS', () => {
  expect(apiError({ ...api, PLATFORM_ORIGINS: undefined })).toMatch(/PLATFORM_ORIGINS must be set/);
  expect(apiError({ ...api, PLATFORM_ORIGINS: 'http://platform.jantrik.com.bd' })).toMatch(
    /not https/,
  );
  expect(apiError({ ...api, PLATFORM_ORIGINS: 'https://admin.jantrik.com.bd' })).toMatch(
    /also in CORS_ORIGINS/,
  );
  expect(apiError({ ...api, PLATFORM_ORIGINS: 'not a url' })).toMatch(/PLATFORM_ORIGINS/);
  expect(apiError(api)).toBe('');
});
it('normalises entries (case, trailing slash) and keeps the development default', () => {
  expect(
    envSchema.parse({ ...devEnv, PLATFORM_ORIGINS: 'HTTPS://Platform.Jantrik.com.bd/' })
      .PLATFORM_ORIGINS,
  ).toEqual(['https://platform.jantrik.com.bd']);
  expect(envSchema.parse(devEnv).PLATFORM_ORIGINS).toEqual(['http://localhost:3000']);
});
```

The existing "accepts the API as Playwright starts it" case must still pass with no
`PLATFORM_ORIGINS` set.

- [ ] **Step 2: Run them.** Run
      `pnpm --filter @jantrik/api exec vitest run src/platform src/config test/platform-auth.e2e-spec.ts`.
      Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `env.ts`: `PLATFORM_ORIGINS` is like `CORS_ORIGINS`, plus `new URL(o).origin` on each entry,
    with a zod issue for an entry that is not a URL.
  - `production-env.ts`:
    - `apiEnvironmentProblems` adds `PLATFORM_ORIGINS` to the variables production must set;
    - `apiProductionProblems` adds a check of each entry with `unsafeOrigin`, and that it is in
      `CORS_ORIGINS`.
  - The guard, right after `if (!mode) return true;`:

```ts
if (!isPlatformOrigin(req.get('Origin'), this.originEnv)) {
  throw apiError(403, 'PLATFORM_ORIGIN_REFUSED', 'Platform requests come from the platform app');
}
```

`this.originEnv` is read once from `ConfigService` in the constructor.

- [ ] **Step 4: Run them and see them pass**, the same command. Then run the whole API suite:
      `pnpm --filter @jantrik/api exec vitest run`. Expected: PASS.
- [ ] **Step 5: Check the web side by hand** with
      `grep -rn "/platform/" apps/web/src --include=*.ts --include=*.tsx`. Only the browser client
      (`lib/platform/platform-api.ts`) may call the API's `/platform/*`. A server-side call sends no
      `Origin` and would now be refused. None is expected; record the grep's result in the commit.
- [ ] **Step 6: Commit**: "PlatformAuthGuard answers only the platform's own origin
      (PLATFORM_ORIGINS, required in production; 403 PLATFORM_ORIGIN_REFUSED before any other check);
      the Caddy rule stays as a second layer (S27, sprint 1 P0)".

### Task 6: A Redis ACL user for the receiver

**Files:**

- Create: `deploy/redis/ingest-user.acl`. One line of rules: `{prefix}` stands for `QUEUE_PREFIX`,
  `#` lines are comments. The starting rule:
  `resetkeys ~ingest:* ~rl:ingest-* ~{prefix}:devices:* resetchannels -@all +@read +@write +@scripting +@connection -@dangerous +info -script|flush -script|kill`.
  The test decides the final rule, and each command added is explained in a comment.
- Create: `deploy/redis/start-redis.sh` (POSIX sh, shellcheck-clean):
  - it reads `REDIS_INGEST_PASSWORD`, `QUEUE_PREFIX` and the rules file;
  - it refuses to start when the password is missing;
  - it runs `exec redis-server … --requirepass "$REDIS_PASSWORD" --user jantrik_ingest on ">$REDIS_INGEST_PASSWORD" <rules>`.
- Create: `deploy/redis/check-ingest-acl.sh`. It runs `redis-cli --user jantrik_ingest` and expects:
  - `ACL WHOAMI` → `jantrik_ingest`;
  - `SET rl:ingest-ip:check 1 EX 5` → OK;
  - `SET otp:check 1` and `FLUSHALL` → NOPERM.

  CI and deploy.md (after each deploy) use it.

- Create: `apps/api/test/redis-acl.e2e-spec.ts`
- Modify: `deploy/docker-compose.prod.yml`:
  - Redis: mount `./redis` read-only and run `start-redis.sh`, with the env `REDIS_INGEST_PASSWORD`
    and `QUEUE_PREFIX`;
  - receiver: `REDIS_URL: redis://jantrik_ingest:${REDIS_INGEST_PASSWORD:?}@redis:6379`.
- Modify: `deploy/.env.prod.example`, `apps/api/src/config/production-env.ts`
  (`receiverProductionProblems`: the URL must name the user `jantrik_ingest`) and its spec.
- Modify: `.github/workflows/ci.yml` ("Production roles, backup and restore" job):
  - add `REDIS_PASSWORD` and `REDIS_INGEST_PASSWORD` to the throwaway passwords;
  - a step that runs `docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod.example up -d --wait redis`
    and then `sh deploy/redis/check-ingest-acl.sh`;
  - shellcheck also covers `deploy/redis/*.sh`.

**Interfaces:**

- Consumes: `RateLimiter` (`hit`, `peek`), `DEVICES_QUEUE` and the receiver's key names
  (`ingest.service.ts`: `ingest:refused`, `ingest:refused-log:<sn>`, `ingest:trusted:<sn>:<bucket>`).
- Produces: `INGEST_REDIS_USER = 'jantrik_ingest'` (in `production-env.ts`) and
  `deploy/redis/ingest-user.acl`.

- [ ] **Step 1: Write the failing tests**

```ts
// redis-acl.e2e-spec.ts: against REDIS_URL_TEST (database 1)
// beforeAll: admin.acl('SETUSER', user, 'reset', 'on', `>${pw}`, ...rules('p0acl'), '+select')  (A4)
// afterAll: ACL DELUSER, delete the test's keys, close every connection
it('the production rules have no select and no channel', () => {
  expect(readRules()).not.toMatch(/\bselect\b|&/i);
});
it('runs everything the receiver does with Redis', async () => {
  const limiter = new RateLimiter(asUser);
  await limiter.hit({ key: 'ingest-ip:203.0.113.0', limit: 10, windowSec: 60 });
  await limiter.peek('ingest-refused-ip:203.0.113.0');
  await asUser.set('ingest:trusted:SN1:203.0.113.0', '1', 'EX', 60);
  await asUser.exists('ingest:trusted:SN1:203.0.113.0');
  await asUser.multi().lpush('ingest:refused', '{}').ltrim('ingest:refused', 0, 99).exec();
  await asUser.set('ingest:refused-log:SN1', '1', 'EX', 60, 'NX');
  const queue = new Queue(DEVICES_QUEUE, { connection: asUser, prefix: 'p0acl' });
  const job = await queue.add('process', { tenantId: 't', deviceId: 'd' });
  // review focus 4: the worker's full-rights view sees an ordinary waiting job
  const full = new Queue(DEVICES_QUEUE, { connection: admin, prefix: 'p0acl' });
  expect(await (await full.getJob(job.id!))?.getState()).toBe('waiting');
});
it('refuses everything else', async () => {
  for (const attempt of [
    () => asUser.flushall(),
    () => asUser.keys('*'),
    () => asUser.config('GET', 'maxmemory'),
    () => asUser.get('rl:otp-phone-day:+8801700000000'),
    () => asUser.set('otp:x', '1'),
    () => asUser.acl('LIST'),
    () => asUser.script('FLUSH'),
    () => asUser.eval("return redis.call('flushall')", 0),
    () => new Queue('sms', { connection: asUser, prefix: 'p0acl' }).add('x', {}),
    () => asUser.subscribe('anything'),
  ]) {
    await expect(attempt()).rejects.toThrow(/NOPERM|no permissions/i); // a script's inner refusal reads differently
  }
});

// production-env.spec.ts (review focus 5)
it("the receiver's REDIS_URL must log in as jantrik_ingest", () => {
  expect(receiverError(receiver)).toMatch(/REDIS_URL.*jantrik_ingest/); // no user in the URL
  expect(
    receiverError({ ...receiver, REDIS_URL: `redis://default:${'f3'.repeat(24)}@redis:6379` }),
  ).toMatch(/jantrik_ingest/);
  expect(
    receiverError({
      ...receiver,
      REDIS_URL: `redis://jantrik_ingest:${'f3'.repeat(24)}@redis:6379`,
    }),
  ).toBe('');
});
```

The spec's `receiver` fixture changes to the `jantrik_ingest` URL. Its existing cases keep their
meaning.

- [ ] **Step 2: Run them.** Run
      `pnpm --filter @jantrik/api exec vitest run test/redis-acl.e2e-spec.ts src/config/production-env.spec.ts`.
      Expected: FAIL.
- [ ] **Step 3: Write the rules file, the start script and the compose and CI changes, and the
      receiver's production rule.** Then tighten the rules until the first test passes with nothing
      extra:
  - each command the receiver's real calls need is added by name, with a comment saying who needs
    it (e.g. BullMQ's `INFO` version check);
  - a whole category is never added to make a test pass.
- [ ] **Step 4: Run them and see them pass.** Then check the compose file:
      `docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod.example config --quiet`.
      Then run the CI step by hand, once, with throwaway passwords (`up -d --wait redis`, then
      `check-ingest-acl.sh`, then `down -v`). Expected: PASS, then `jantrik_ingest`, OK, NOPERM,
      NOPERM.
- [ ] **Step 5: Commit**: "The device receiver logs in to Redis as jantrik_ingest: its own keys
      (ingest:_, rl:ingest-_) and its queue only, no Pub/Sub, no dangerous commands; one rules file
      for the compose file and the test (sprint 1, P0)".

### Task 7: Docs, the env examples and the decisions

**Files:** `.env.example`, `docs/auth.md` (Configuration table: `PLATFORM_ORIGINS`; Platform
admins), `docs/platform.md` (Session: the origin check), `docs/database.md`, `docs/deploy.md`,
`docs/devices.md`, `docs/decisions-pending.md`.

- **`docs/database.md`:**
  - the role table: `jantrik_ingest_app` has a 5 s `statement_timeout`; all runtime logins pass
    the start-up privilege check;
  - the "existing local volume" commands add
    `ALTER ROLE jantrik_ingest_app SET statement_timeout = '5s'`.
- **`docs/deploy.md`:**
  - Environment checks: the new rules;
  - §10: the Caddy rule is now the second layer;
  - Redis: the ACL user and `check-ingest-acl.sh` after a deploy;
  - "What needs the owner": the three items are done;
  - the upgrade note for an existing server:
    `ALTER ROLE … SET statement_timeout = '5s'` once as the superuser (optional, the pool enforces
    it), set `REDIS_INGEST_PASSWORD`, then `compose.sh up -d`.
- **`docs/devices.md`:** the receiver's 5 s limit and Redis user.
- **`docs/decisions-pending.md`:**
  - #79: decided, 5 s, the pool size unchanged;
  - the "Recorded for the owner, not built" items: built;
  - a new "Sprint 1, P0" section recording A1–A4.

- [ ] **Step 1: Write the docs.** Run `pnpm format:check`. Expected: PASS.
- [ ] **Step 2: Commit**: "Docs for sprint 1 P0: the platform origin check, the login privilege
      check, the receiver's 5 s limit and Redis user; #79 decided".

### Task 8: Gates, review, PR

- [ ] **Step 1: Run the full gates** (Docker up; nothing on ports 3000 or 4000; check the ports
      first, since a stopped shell can leave servers running):
      `pnpm lint && pnpm typecheck && pnpm format:check && pnpm test && pnpm build && pnpm e2e`.
      Expected: all pass. The Playwright platform specs pass unchanged, because the browser's origin
      `http://localhost:3000` is the default.
- [ ] **Step 2: Run the review subagent** on the whole branch diff (security and auth focus). Give
      it this plan's review focus, the global constraints and the diff, not my conclusions. Fix what
      it finds, and re-run the affected tests and then the full gates.
- [ ] **Step 3: Push and open the PR.** Push
      `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -u origin feature/sprint-1-p0-security`,
      then open the PR to `main`. Its body covers what changed, the owner's decisions (#79, S27,
      A1–A4), how to test, and the upgrade note.
- [ ] **Step 4: Wait for CI to be green** on the PR. Then report: files changed, how to run it,
      what is left (nothing planned), new decisions.

## Self-review

- **Spec coverage:**
  - the Origin check (Task 5);
  - the Redis ACL (Task 6);
  - the fail-closed superuser and BYPASSRLS check for the app login, and also the platform and
    receiver logins as deploy.md asked (Tasks 1, 3, 4);
  - the receiver's 5 s `statement_timeout` (Task 4);
  - the docs and decisions (Task 7);
  - S27 keeps Caddy (Task 7, deploy.md).
- **Types:** `LoginPrivileges`, `readLoginPrivileges`, `loginPrivilegeProblems`,
  `runStartupCheck`, `STARTUP_RETRY_DELAYS_MS`, `isPlatformOrigin`, `PLATFORM_ORIGINS` and
  `INGEST_REDIS_USER` have the same names in every task.
- **Review focus:**
  - 1 is tested in Task 5 (the `http://app.test` case);
  - 2 in Task 3 (unreachable, then it starts);
  - 3 in Task 4 (the cut upload);
  - 4 in Task 6 (the worker's view of the job);
  - 5 in Tasks 5 and 6 (production-env cases).

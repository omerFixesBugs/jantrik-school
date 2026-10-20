# Database guide

How the Jantrik School database keeps every institute's data separate, and what you must do when
you add a table. Code lives in [`packages/db`](../packages/db).

## Two kinds of tables

| Kind             | Examples                                                                                     | `tenant_id`    | Row-Level Security                               | App role can                          |
| ---------------- | -------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------ | ------------------------------------- |
| **Global**       | `institute_types`, `template_*`, `grading_scheme_templates`, `grade_band_templates`, `users` | no             | templates: no; `users`: yes (see below)          | read templates; `users` via RLS       |
| **User-owned**   | `sessions`, `refresh_tokens`                                                                 | no (`user_id`) | enabled **and forced** (`user_id = app.user_id`) | own sessions only                     |
| **Tenant-owned** | `tenants`, `students`, `sections`, `grade_bands`, … (everything else)                        | `NOT NULL`     | enabled **and forced**                           | read/write its own tenant's rows only |

**`platform_sms_logs`** is a global table for SMS sent before any tenant is known (login OTP),
kept for cost tracking. The app role may **only INSERT** into it: no SELECT, UPDATE or DELETE,
because it holds the phone numbers of every user. Write it with `createMany` (a plain INSERT);
`create()` uses `RETURNING`, which needs SELECT and is refused. The OTP text is never stored.

Templates are global and read-only at runtime. When an institute signs up, `provisionTenant()`
**copies** its institute type's template (labels, grading scheme + bands, study groups, class
levels, subjects) into tenant-owned tables. Each copy keeps a `source_template_id` for
traceability, but there is no live link: a tenant editing its copy never affects other tenants or
the template.

## Database roles

| Role                   | Used by                                                    | Notes                                                                                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`             | Docker admin only                                          | Superuser. Only the init script uses it.                                                                                                                                                                                                                                           |
| `jantrik_owner`        | `prisma migrate`, template seed (`DATABASE_MIGRATION_URL`) | Owns all tables. **Not** a superuser, so `FORCE ROW LEVEL SECURITY` applies to it too. Has `CREATEDB` for Prisma's shadow database.                                                                                                                                                |
| `jantrik_app`          | API runtime, demo seed (`DATABASE_URL`)                    | `NOSUPERUSER NOBYPASSRLS`, owns nothing. Gets only the grants written in migrations.                                                                                                                                                                                               |
| `jantrik_auth`         | Owner of the auth `SECURITY DEFINER` functions             | `NOLOGIN`, **not** BYPASSRLS: sees rows only through explicit `TO jantrik_auth` policies on users, memberships, tenants, sessions, refresh_tokens. `jantrik_owner` may `SET ROLE` to it but does **not inherit** it (otherwise those policies would let the owner see everything). |
| `jantrik_search`       | Owner of `search_student_ids()`                            | Same rules as `jantrik_auth`, with SELECT-only `TO jantrik_search` policies on students, guardians, student_guardians. See "Student search" below.                                                                                                                                 |
| `jantrik_platform`     | Owner of the `platform_*` functions (Jantrik's own admins) | Same rules as `jantrik_auth`. Grants on the platform tables and explicit `TO jantrik_platform` policies for institute metadata only, never student/guardian/attendance rows. See [platform.md](platform.md).                                                                       |
| `jantrik_platform_app` | The API's platform module (`DATABASE_PLATFORM_URL`)        | LOGIN, NOSUPERUSER, NOBYPASSRLS, owns nothing. The **only** role with EXECUTE on the `platform_*` functions (`jantrik_app` has none), and that is all it has: not a member of `jantrik_app`, no table grants, so it never reads an institute's rows.                               |

The roles and databases (`jantrik`, `jantrik_test`) are created by
[`docker/postgres/init/01-roles.sh`](../docker/postgres/init/01-roles.sh). That script only runs
on an empty volume, so after changing it run `docker compose down -v && docker compose up -d`.
In production, infrastructure creates the same roles.

**Existing local volume created before these roles/databases existed?** Add them once instead of
wiping (each statement errors harmlessly if the object already exists):

```bash
docker compose exec postgres psql -U postgres \
  -c "CREATE ROLE jantrik_auth NOLOGIN NOSUPERUSER NOBYPASSRLS" \
  -c "GRANT jantrik_auth TO jantrik_owner WITH INHERIT FALSE, SET TRUE" \
  -c "CREATE ROLE jantrik_search NOLOGIN NOSUPERUSER NOBYPASSRLS" \
  -c "GRANT jantrik_search TO jantrik_owner WITH INHERIT FALSE, SET TRUE" \
  -c "CREATE ROLE jantrik_platform NOLOGIN NOSUPERUSER NOBYPASSRLS" \
  -c "GRANT jantrik_platform TO jantrik_owner WITH INHERIT FALSE, SET TRUE" \
  -c "CREATE ROLE jantrik_platform_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'platform_dev_password'" \
  -c "CREATE DATABASE jantrik_e2e OWNER jantrik_owner"
# A volume that already granted jantrik_app to jantrik_platform_app (early step 8): take it back.
docker compose exec postgres psql -U postgres -c "REVOKE jantrik_app FROM jantrik_platform_app"
docker compose exec postgres psql -U postgres -d jantrik_e2e \
  -c "ALTER SCHEMA public OWNER TO jantrik_owner" \
  -c "REVOKE ALL ON SCHEMA public FROM PUBLIC" \
  -c "GRANT USAGE ON SCHEMA public TO jantrik_app"
# Then apply the migrations (they grant the new roles what they need, e.g. schema USAGE):
pnpm db:deploy
```

## Global tables of the platform

`platform_admins`, `platform_admin_backup_codes`, `platform_sessions` and `platform_audit_logs`
are global (no `tenant_id`, no RLS) and protected by grants:

- `jantrik_app` has none;
- `jantrik_platform` has what its functions need (the audit log is append-only);
- the owner role (migrations, the `pnpm platform:admin` CLI) owns them.

The API uses them only through the `platform_*` definer functions. A platform request's
transaction sets `app.platform_session` (the session token's hash);
`app_current_platform_admin_id()` turns it into the admin or raises. See
[platform.md](platform.md).

### What the platform may change in an institute (step 8, part 2)

- **`tenant_subscriptions`** (tenant table, at most one row per institute): Jantrik's plan
  (pricing in paisa, cycle, yearly discount, days to pay, trial end) and limits (student limit,
  SMS ceiling). `jantrik_app` may only SELECT its own row (admissions and the SMS cap read it);
  only the platform functions write it. Institutes created before part 2 have none: no plan, no
  limits.
- **`tenants` and `tenant_modules`:** `jantrik_app` has no UPDATE or DELETE (provisioning still
  INSERTs), so an institute cannot un-suspend itself or switch a module on. Provisioning writes a
  `tenant_modules` row for every module, and the restrictive policy `provisioning_only` lets
  `jantrik_app` insert module rows only while its institute has none, so no module can be added
  later either. `jantrik_platform`
  may UPDATE only `tenants (status, suspended_from, suspended_at, updated_at)`.
  `tenants.suspended_from` keeps the status a suspension returns to.
- **Billing** (part 3): `platform_invoices`, `platform_invoice_lines` and `platform_payments`
  are tenant tables. `jantrik_app` may only SELECT its own rows (the owner's overdue notice);
  `jantrik_platform` inserts, and updates invoices only (status, paid amount, void). No DELETE for
  anyone: billing is history. One live invoice per institute and period is a partial unique index
  (`WHERE status <> 'VOID'`), so a voided month can be invoiced again.
- **`platform_settings`** (part 4): one global row (`CHECK (id = 1)`), Jantrik's SMS rate.
  `jantrik_app` may SELECT only `sms_cost_per_segment_paisa` (it copies the rate onto each SMS when
  sent: `sms_logs.cost_paisa`, `platform_sms_logs.cost_paisa`); only `platform_set_sms_cost`
  changes it. Read it without a `WHERE id = 1`: the app has no right to the `id` column.
- **`onboarding_progress`** (part 5, tenant table, at most one row per institute): the new
  owner's setup wizard. Provisioning writes it for institutes the platform creates; `jantrik_app`
  may SELECT, INSERT and UPDATE its own row (no DELETE). `steps` is a jsonb object whose keys are
  the six step names and whose values are `'done'` or `'skipped'` (CHECK
  `onboarding_progress_steps`).
- **`jantrik_platform` reads institute tables by column** (counts, owner names and phones), never
  a student's, guardian's or SMS's content; see [platform.md](platform.md).
- Tests that suspend an institute or switch a module go through the platform API
  (`platformAdminCookie` in `apps/api/test/support/platform.ts`).

## Row-Level Security

Every tenant-owned table has the same policy (the `tenants` table uses `id` instead of `tenant_id`):

```sql
ALTER TABLE x ENABLE ROW LEVEL SECURITY;
ALTER TABLE x FORCE ROW LEVEL SECURITY;      -- applies to the table owner as well
CREATE POLICY tenant_isolation ON x
  USING      (tenant_id = app_current_tenant_id())   -- which rows you can see / update / delete
  WITH CHECK (tenant_id = app_current_tenant_id());  -- which rows you can write
```

`app_current_tenant_id()` returns `NULLIF(current_setting('app.tenant_id', true), '')::uuid`:

- **No context set → NULL → no rows.** Forgetting to set the tenant shows nothing; it never shows
  everything.
- `NULLIF(..., '')` matters: once a pooled connection has run a `SET LOCAL`, Postgres reports the
  setting as `''` (not NULL) afterwards, and `''::uuid` would throw.

**Cross-tenant references.** Foreign-key checks ignore RLS. Without extra protection, tenant A
could store a reference to tenant B's student if it knew the UUID. So every tenant table has
`UNIQUE (tenant_id, id)`, and every reference to another tenant-owned table is a **composite
foreign key**: `(tenant_id, student_id) → students (tenant_id, id)`. This includes optional
references such as `sections.shift_id`. A row can only point at rows of its own tenant.

### Users, sessions and the auth functions

`app_current_user_id()` works like the tenant helper, reading `app.user_id`.

- **`users`** (RLS enabled + forced):
  - **Visible:** yourself (`id = app.user_id`), or anyone with a membership in the current tenant
    that is not `INVITED` or `DECLINED` (the `users_visible` view). An invited person stays hidden
    until they accept.
  - **Updatable:** your own row only. One person can belong to several tenants, so staff of
    tenant A must not edit them.
  - **No INSERT or DELETE for the app.** Create people with `findOrCreateUser(tx, phone, name)`,
    which needs a tenant context. It returns only the id, so a person from another tenant stays
    hidden until they get a membership here.
- **`sessions`, `refresh_tokens`:** visible to their own user only.
- **Lookups that must happen before any context exists** go through narrow `SECURITY DEFINER`
  functions:
  - Each is owned by `jantrik_auth`, pins `search_path = pg_catalog, public, pg_temp` (`pg_temp`
    last, so a temporary table cannot stand in for a real one), and is executable only by
    `jantrik_app`.
  - `auth_find_user_for_login(phone, email)`
  - `auth_list_my_memberships()`: uses `app.user_id`, with no user parameter. It also returns
    `invited_at`, so the login flow can show pending invitations.
  - `auth_resolve_tenant(slug)`
  - `auth_find_refresh_token(hash)`
  - `app_find_or_create_user(phone, name, name_bn)`: `name_bn` is written only for a new person
- **Don't add more casually.** Each one is a deliberate hole in RLS.
- **Never accept a tenant (or user) id as a parameter.** Scope only by `app_current_tenant_id()`
  / `app_current_user_id()`, so a missing context returns nothing. The only exceptions are the
  three pre-context login lookups and the `platform_*` functions (`docs/platform.md`): those
  belong to `jantrik_platform`, need a live platform session instead, and may take an institute
  id. `test/schema-safety.test.ts` fails on any other definer function that takes a tenant/uuid
  argument or isn't scoped by context.
- **Every definer function** pins exactly `search_path = pg_catalog, public, pg_temp`, and PUBLIC
  may not run it (`schema-safety.test.ts` checks every one).
- **Platform functions** (owned by `jantrik_platform`): EXECUTE for `jantrik_platform_app` only,
  never `jantrik_app`. Don't copy the `GRANT … TO jantrik_app` of an auth function;
  `schema-safety.test.ts` checks this by owner, so a new function is covered too.
- **Privileges on a definer function:** REVOKE/GRANT _before_ `ALTER FUNCTION … OWNER TO`, or
  `SET ROLE <owner>` first. Only a function's owner can change its privileges. A REVOKE run by
  anyone else is a silent no-op, which left PUBLIC with EXECUTE until migration
  `fix_definer_function_privileges`. Tests check the _effective_ ACL with
  `acldefault()`, because a NULL `proacl` means "default", and the default grants PUBLIC.

### Student imports

- `student_imports` keeps an import as history (no DELETE grant). `rows` (the raw cells: phones,
  birth registration numbers) is set to NULL when the import ends, fails or passes retention
  (7 days unfinished, 1 day stuck); `results` (one entry per row) stays.
- `duplicate_overrides` (`integer[]`, at most 5000): the "possible duplicate" rows the admin chose
  to import anyway (decision #22). It is not part of `results`, because re-checking rewrites those.
- Retention runs daily per institute (`expire-imports` job, institutes taken from the Redis set
  `imports:raw-tenants`, no cross-tenant query) and lazily on upload and listing (decision #23).

### Memberships and staff invitations

- `membership_status`: `ACTIVE`, `DISABLED`, `INVITED`, `DECLINED`.
- Adding staff creates `INVITED` rows with `invited_at`. They give no access: roles, switching
  tenant and the roles cache only count `ACTIVE`. The person accepts (`ACTIVE`) or declines
  (`DECLINED`) after logging in. After 14 days (`INVITATION_DAYS`) an unanswered invitation is
  treated as expired; nothing is stored for that, it is computed from `invited_at`.
- **`staff_profiles`** (tenant table, one row per staff member): the name and phone the
  institute typed. `POST /staff`, the demo seed and the test helper `addMember` create one, and
  `TenantAccessService.setMemberRoles` refuses staff roles for someone without one. Staff lists,
  section teachers and "updated by" labels read **only** this (`staffNames`, `staffRef`), never
  `users`: staff added before profiles existed (no backfill) are shown unnamed ("—"). No DELETE
  grant.
- **Global names stay private (decision #5).** `users.name`, `name_bn` and `email` are read only
  by the self endpoints (`/auth/me`, login, refresh: the signed-in person's own account).
  Guardians are shown by their `guardians` row, students by `students`, staff by
  `staff_profiles`. `src/common/global-names.spec.ts` fails the build if other code reads them;
  `test/no-global-names.e2e-spec.ts` checks the raw responses.

### Student search (`search_student_ids`)

**The problem.** ILIKE's operator (`texticlike`) is not LEAKPROOF. Under RLS, Postgres evaluates
non-leakproof predicates only after the row-security qual, so it **cannot use an index for ILIKE
on an RLS table**. A trigram GIN index would be ignored: search degrades to scanning all of the
tenant's rows.

**The fix.** Search runs in `search_student_ids(term, phone, limit)`:

- It is SECURITY DEFINER, owned by `jantrik_search`, and executable only by `jantrik_app`.
- It filters by `app_current_tenant_id()` **explicitly**, escapes LIKE wildcards, skips
  soft-deleted students, and returns **ids only**.
- The API then loads those students through normal RLS (`searchStudentIds(tx, …)` in
  `@jantrik/db`).

**Indexes.** The trigram indexes (`pg_trgm`) are on students.name_bn, students.name_en,
students.student_code and guardians.phone.

**Tests.** `test/search-indexes.test.ts` proves:

- the indexes are usable by the function's role
- they are unusable under tenant RLS
- results never cross tenants

## Querying: `withContext`, `withTenant`, `tenantClient`

> **In the API, services never call these.** Every authenticated request already runs inside one
> RLS transaction (tenant + user) opened by `TenantContextInterceptor`. Inject `Db` and use
> `this.db.tx`. An ESLint rule forbids these imports outside `apps/api/src/tenancy` and
> `apps/api/src/auth`. See [docs/auth.md](auth.md).

`withContext(prisma, { tenantId?, userId? }, fn)` sets both settings in one transaction;
`withTenant(prisma, tenantId, fn)` is the tenant-only shorthand.

Both set `app.tenant_id` with `set_config(..., true)`, the parameter-safe form of `SET LOCAL`. The
value disappears when the transaction ends, so a pooled connection never carries one tenant into
the next request.

```ts
import { createPrismaClient, tenantClient, withTenant } from '@jantrik/db';

const prisma = createPrismaClient(process.env.DATABASE_URL); // app role

// One unit of work, one transaction: several reads/writes, raw SQL.
await withTenant(prisma, tenantId, async (tx) => {
  const student = await tx.student.create({
    data: { tenantId, studentCode: 'S-1', nameEn: 'Rafi' },
  });
  await tx.enrolment.create({ data: { tenantId, studentId: student.id /* … */ } });
  await tx.$queryRaw`SELECT count(*) FROM students`; // scoped
});

// Convenience for single queries: each model call runs in its own scoped transaction.
const db = tenantClient(prisma, tenantId);
const students = await db.student.findMany();
```

|                                           | `withTenant(prisma, id, fn)`   | `tenantClient(prisma, id)`      |
| ----------------------------------------- | ------------------------------ | ------------------------------- |
| Transaction                               | one, around the whole callback | one per model operation         |
| Several writes that must succeed together | ✅                             | ❌ (each is separate)           |
| `$queryRaw` / `$executeRaw`               | ✅ scoped                      | ❌ **not scoped**: sees no rows |
| Typical use                               | services and commands          | simple reads                    |

You still pass `tenantId` in `data` when you create rows. RLS rejects the write if it doesn't
match the context.

Without either helper, queries run with no tenant and return nothing. That is intended.

## Other conventions

- UUIDv7 primary keys (`@default(uuid(7))`), snake_case names via `@map` / `@@map`, and
  `created_at` / `updated_at` (`timestamptz(3)`) on every table. `audit_logs` is append-only:
  it has `created_at` only, and the app role has only SELECT and INSERT on it.
- Money is integer paisa. Dates are UTC. `date` columns hold calendar dates; shift times are local
  wall-clock times.
- Phone numbers are E.164 Bangladeshi mobiles (`+8801XXXXXXXXX`), enforced by a CHECK constraint.
  Normalise input with `normalizeBdPhone` / `bdPhoneSchema` from `@jantrik/shared`.
- Students are soft-deleted (`deleted_at`). Queries must filter `deletedAt: null` themselves.
- **History tables have no DELETE grant:** `attendance_sessions`, `attendance_records` and
  `sms_logs` (we bill from it) can be inserted and updated by the app, never deleted.
- **Don't backfill tenant rows in a migration.** Migrations run as `jantrik_owner`, and FORCE RLS
  hides every tenant row from it, so an `INSERT … SELECT FROM tenants` silently inserts nothing.
  Create per-tenant rows in `provisionTenant()`, and give existing tenants defaults in code
  (e.g. `AttendanceSettingsService.load()` falls back to the institute type's defaults until
  an admin saves the settings).
- **A new CHECK on an existing tenant table is checked against every row** (RLS does not apply
  to that scan), so it fails on rows that break it. When it failed here (part 5, on the test
  database), the statements before the error had stayed applied: the old constraint was dropped
  and the new one missing. Use `DROP CONSTRAINT IF EXISTS` when replacing a constraint, and fix the
  rows before marking the migration rolled back (`prisma migrate resolve --rolled-back`).
- **Attendance dates** are `date` columns holding the calendar day in the tenant's timezone
  (`tenants.timezone`). "Today" is always computed on the server (`todayIn(timezone)` in
  `@jantrik/shared`, also in `GET /me/context`), never taken from the device.
- **SMS dedupe:** `sms_logs` has a partial unique index on `(tenant_id, dedupe_key)`, so one key
  (e.g. `absent:<student_id>:<date>`) can produce at most one SMS per tenant, ever. Rows held back
  by the daily cap keep their key too.
- CHECK constraints, RLS, grants and functions live in hand-written SQL migrations. Partial unique
  indexes are declared in the Prisma schema (`partialIndexes` preview feature), so Prisma knows
  about them and won't try to drop them.
- Grades: `calculateGrade(percent, bands, roundingMode)` in `@jantrik/shared`. A percentage gets
  the band with the highest `min_percent` ≤ it, after the scheme's `rounding_mode`
  (`NONE` | `ROUND_HALF_UP` | `CEIL`) is applied.

## Checklist: adding a tenant-owned table

1. **Prisma model.** Add these to `packages/db/prisma/schema.prisma`:
   - `tenantId String @map("tenant_id") @db.Uuid` and a `tenant` relation.
   - `@@unique([tenantId, id])`, so other tables can reference it with a composite key.
   - For every reference to another tenant-owned table, a composite relation:
     `@relation(fields: [tenantId, xId], references: [tenantId, id])`. This applies to optional
     references too.
   - An index whose **first** column is `tenant_id`, matching your common lookups.
   - snake_case `@map`s, `createdAt`, and `updatedAt @default(now()) @updatedAt`.
2. **Generate the migration**: `pnpm db:migrate --create-only --name <name>`.
3. **Append the RLS SQL** to the same migration file, before applying it:
   ```sql
   ALTER TABLE my_table ENABLE ROW LEVEL SECURITY;
   ALTER TABLE my_table FORCE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON my_table
     USING (tenant_id = app_current_tenant_id())
     WITH CHECK (tenant_id = app_current_tenant_id());
   GRANT SELECT, INSERT, UPDATE, DELETE ON my_table TO jantrik_app;
   ```
   There are no default privileges. Without the `GRANT`, the app gets "permission denied", which
   is deliberate. Add any CHECK constraints here as well.
4. **Apply it**: `pnpm db:migrate`.
5. **Check for drift**: `pnpm --filter @jantrik/db exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
   must print an empty migration.
6. **If the table is copied from a template**, add the template table (global, `GRANT SELECT`
   only), seed it in `src/reference-data/templates.ts` and copy it in `provisionTenant()`.
7. **Run `pnpm test`.** `test/schema-safety.test.ts` fails if any table with a `tenant_id` column
   lacks enabled + forced RLS, the `tenant_isolation` policy, `NOT NULL`, or a leading index.
   Add isolation tests for any non-trivial access pattern.

A **global** table needs no `tenant_id` and no RLS. It still needs an explicit `GRANT` (usually
`SELECT` only) and a reason it is not per-tenant.

## Commands

```bash
docker compose up -d --wait   # Postgres + Redis
pnpm db:migrate               # create/apply migrations (owner role)
pnpm db:seed                  # templates (owner) + demo tenants (app role); refuses NODE_ENV=production
pnpm --filter @jantrik/db test   # integration tests against jantrik_test (needs Docker)
```

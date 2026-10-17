# Database guide

How the Jantrik School database keeps every institute's data separate, and what you must do when
you add a table. Code lives in [`packages/db`](../packages/db).

## Two kinds of tables

| Kind             | Examples                                                                                     | `tenant_id` | Row-Level Security     | App role can                          |
| ---------------- | -------------------------------------------------------------------------------------------- | ----------- | ---------------------- | ------------------------------------- |
| **Global**       | `institute_types`, `template_*`, `grading_scheme_templates`, `grade_band_templates`, `users` | no          | no                     | read templates; read/write `users`    |
| **Tenant-owned** | `tenants`, `students`, `sections`, `grade_bands`, … (everything else)                        | `NOT NULL`  | enabled **and forced** | read/write its own tenant's rows only |

Templates are global and read-only at runtime. When an institute signs up, `provisionTenant()`
**copies** its institute type's template (labels, grading scheme + bands, study groups, class
levels, subjects) into tenant-owned tables. Each copy keeps a `source_template_id` for
traceability, but there is no live link: a tenant editing its copy never affects other tenants or
the template.

## Database roles

| Role            | Used by                                                    | Notes                                                                                                                               |
| --------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`      | Docker admin only                                          | Superuser. Only the init script uses it.                                                                                            |
| `jantrik_owner` | `prisma migrate`, template seed (`DATABASE_MIGRATION_URL`) | Owns all tables. **Not** a superuser, so `FORCE ROW LEVEL SECURITY` applies to it too. Has `CREATEDB` for Prisma's shadow database. |
| `jantrik_app`   | API runtime, demo seed (`DATABASE_URL`)                    | `NOSUPERUSER NOBYPASSRLS`, owns nothing. Gets only the grants written in migrations.                                                |

The roles and databases (`jantrik`, `jantrik_test`) are created by
[`docker/postgres/init/01-roles.sh`](../docker/postgres/init/01-roles.sh). That script only runs
on an empty volume, so after changing it run `docker compose down -v && docker compose up -d`.
In production, infrastructure creates the same two roles.

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

## Querying: `withTenant` vs `tenantClient`

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

**Not handled yet (auth task):** resolving a tenant from its slug and listing a user's memberships
across tenants both happen _before_ a tenant is known. They will be narrow `SECURITY DEFINER`
functions. Do not work around RLS for them in application code.

## Other conventions

- UUIDv7 primary keys (`@default(uuid(7))`), snake_case names via `@map` / `@@map`, and
  `created_at` / `updated_at` (`timestamptz(3)`) on every table. `audit_logs` is append-only:
  it has `created_at` only, and the app role has only SELECT and INSERT on it.
- Money is integer paisa. Dates are UTC. `date` columns hold calendar dates; shift times are local
  wall-clock times.
- Phone numbers are E.164 Bangladeshi mobiles (`+8801XXXXXXXXX`), enforced by a CHECK constraint.
  Normalise input with `normalizeBdPhone` / `bdPhoneSchema` from `@jantrik/shared`.
- Students are soft-deleted (`deleted_at`). Queries must filter `deletedAt: null` themselves.
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
   only), seed it in `src/seed/templates.ts` and copy it in `provisionTenant()`.
7. **Run `pnpm test`.** `test/schema-safety.test.ts` fails if any table with a `tenant_id` column
   lacks enabled + forced RLS, the `tenant_isolation` policy, `NOT NULL`, or a leading index.
   Add isolation tests for any non-trivial access pattern.

A **global** table needs no `tenant_id` and no RLS. It still needs an explicit `GRANT` (usually
`SELECT` only) and a reason it is not per-tenant.

## Commands

```bash
docker compose up -d --wait   # Postgres + Redis
pnpm db:migrate               # create/apply migrations (owner role)
pnpm db:seed                  # templates (owner) + demo tenants shapla-school, alo-coaching (app role)
pnpm --filter @jantrik/db test   # integration tests against jantrik_test (needs Docker)
```

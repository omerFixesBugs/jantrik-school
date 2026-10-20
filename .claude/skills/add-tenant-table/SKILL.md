---
name: add-tenant-table
description: Use when adding a new tenant-owned table (any table with tenant_id) to packages/db: Prisma model, migration with RLS, grants and CHECKs, drift check and isolation tests. Follow every step; skipping one leaves a table another institute can read.
---

# Add a tenant-owned table

The procedure from [docs/database.md](../../../docs/database.md) ("Checklist: adding a
tenant-owned table"). Do every step, in order. Run commands from the repo root.

## 0. Decide

- Is it really tenant-owned? Anything that belongs to one institute is. A **global** table needs
  a written reason, no `tenant_id`, no RLS, and an explicit `GRANT` (usually `SELECT` only).
- Which other tenant tables will it reference? Each needs a **composite** foreign key.
- References to the global `users` table **cannot** be composite (users have no `tenant_id`), so the
  database never checks that the person belongs to this tenant. The service must check for an
  ACTIVE membership in the current tenant before writing, and the isolation test must cover it
  (see `section_teachers.user_id`).
- Which grants? Default `SELECT, INSERT, UPDATE, DELETE`. History/billing tables get no DELETE;
  append-only tables get `SELECT, INSERT` only.
- Which CHECK constraints (ranges, formats, enums stored as text)?

## 1. Prisma model (`packages/db/prisma/schema.prisma`)

```prisma
/// One line on what a row is.
model Thing {
  id        String   @id @default(uuid(7)) @db.Uuid
  tenantId  String   @map("tenant_id") @db.Uuid
  studentId String?  @map("student_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(3)

  tenant  Tenant   @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  // Composite, even when optional: a row can only point at its own tenant's rows.
  student Student? @relation(fields: [tenantId, studentId], references: [tenantId, id], onDelete: Restrict)

  @@unique([tenantId, id])          // so other tables can reference it compositely
  @@index([tenantId, studentId])    // FIRST column tenant_id, matching the common lookup
  @@map("things")
}
```

- Add the back-relation on `Tenant` (and on every referenced model).
- snake_case `@map` on every column; `@@map` to a plural snake_case table name.
- Partial unique indexes go in the schema (`where: raw("…")`), not only in SQL.

## 2. Create the migration (do not apply yet)

```bash
pnpm db:migrate --create-only --name <snake_case_name>
```

## 3. Append RLS, grants and CHECKs to that `migration.sql`

```sql
ALTER TABLE things ENABLE ROW LEVEL SECURITY;
ALTER TABLE things FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON things
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON things TO jantrik_app;

ALTER TABLE things ADD CONSTRAINT things_x_range CHECK (x BETWEEN 0 AND 10);
```

- No default privileges exist: without the GRANT the app gets "permission denied".
- **Never backfill tenant rows here**: migrations run as `jantrik_owner`, and FORCE RLS hides every
  tenant row, so `INSERT … SELECT FROM tenants` inserts nothing. Use defaults in code, or
  `provisionTenant()` for new tenants.
- No SECURITY DEFINER function unless unavoidable; if you add one, follow the definer rules in
  docs/database.md (owner `jantrik_auth`/`jantrik_search`, pinned `search_path`, REVOKE/GRANT
  before `OWNER TO`, scoped by `app_current_tenant_id()`, never a tenant/uuid parameter).
  A table that such a function must read also needs its own `TO jantrik_auth` / `TO jantrik_search`
  SELECT policy; without it the function silently sees no rows.
- Changing a definer function's parameters creates a new **overload**: `DROP FUNCTION name(old
args)` in the same migration, so the old one (and its EXECUTE grant) does not linger.

## 4. Apply

```bash
pnpm db:migrate
```

## 5. Drift check: must print an empty migration

```bash
pnpm --filter @jantrik/db exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

## 6. Template copy (only if the table comes from an institute-type template)

Add the global `template_*` table (`GRANT SELECT` only), seed it in
`packages/db/src/reference-data/templates.ts`, copy it in `provisionTenant()` with
`source_template_id`.

## 7. Tests

- `pnpm --filter @jantrik/db test`: `test/schema-safety.test.ts` fails if the table lacks
  enabled + forced RLS, the `tenant_isolation` policy, `NOT NULL tenant_id` or a leading index.
  Add the new table to the `arrayContaining` list in "finds all Phase 1 tenant tables", so a
  missing migration fails the test.
- Add an isolation test in `packages/db/test/` (see `attendance-rls.test.ts`): tenant B cannot
  read, update or delete tenant A's row, cannot insert a row with A's `tenant_id`, and cannot
  point a composite FK at A's rows.
- In the API, services use `this.db.tx` (the request transaction), never `withTenant`, and pass
  `tenantId` in `data` on create.

## 8. Before committing

`pnpm lint && pnpm typecheck && pnpm format:check && pnpm test`, then mention the new table in
docs/database.md if it changes a rule (e.g. a new history table without DELETE).

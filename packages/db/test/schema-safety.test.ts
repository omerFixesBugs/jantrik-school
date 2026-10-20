import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/index.js';
import { appClient, tenantTableNames } from './helpers.js';

// Guards against a future table being added without RLS. See docs/database.md.
describe('schema safety net', () => {
  let app: PrismaClient;

  beforeAll(() => {
    app = appClient();
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it('finds all Phase 1 tenant tables', async () => {
    const tables = await tenantTableNames(app);
    expect(tables).toEqual(
      expect.arrayContaining([
        'tenants',
        'students',
        'shifts',
        'enrolments',
        'audit_logs',
        'student_settings',
        'student_code_counters',
        'student_imports',
        'staff_profiles',
      ]),
    );
    expect(tables.length).toBeGreaterThanOrEqual(18);
  });

  it('every tenant table has RLS enabled + forced and a tenant_isolation policy', async () => {
    const rows = await app.$queryRaw<
      { table: string; enabled: boolean; forced: boolean; policy: boolean }[]
    >`
      SELECT c.relname AS table,
             c.relrowsecurity AS enabled,
             c.relforcerowsecurity AS forced,
             EXISTS (SELECT 1 FROM pg_policy p
                     WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy
      FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relname = ANY(${await tenantTableNames(app)})`;

    const bad = rows.filter((r) => !r.enabled || !r.forced || !r.policy);
    expect(bad).toEqual([]);
  });

  it('every tenant_id column is NOT NULL and leads an index', async () => {
    const rows = await app.$queryRaw<{ table: string; not_null: boolean; indexed: boolean }[]>`
      SELECT c.relname AS table,
             a.attnotnull AS not_null,
             EXISTS (SELECT 1 FROM pg_index i
                     WHERE i.indrelid = c.oid AND i.indkey[0] = a.attnum) AS indexed
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`;

    expect(rows.length).toBeGreaterThanOrEqual(17);
    expect(rows.filter((r) => !r.not_null || !r.indexed)).toEqual([]);
  });

  it('the app role cannot bypass RLS and owns nothing', async () => {
    const [role] = await app.$queryRaw<
      { name: string; superuser: boolean; bypassrls: boolean; owned: bigint }[]
    >`
      SELECT r.rolname AS name, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
             (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid) AS owned
      FROM pg_roles r WHERE r.rolname = current_user`;

    expect(role).toEqual({ name: 'jantrik_app', superuser: false, bypassrls: false, owned: 0n });
  });

  it('the app role cannot write global templates or rewrite the audit log', async () => {
    await expect(app.$executeRaw`UPDATE institute_types SET name_en = 'x'`).rejects.toThrow(
      /permission denied/i,
    );
    await expect(app.$executeRaw`DELETE FROM audit_logs`).rejects.toThrow(/permission denied/i);
    await expect(app.$executeRaw`UPDATE audit_logs SET entity = 'x'`).rejects.toThrow(
      /permission denied/i,
    );
  });

  // SECURITY DEFINER functions see past RLS, so they must never trust a caller-supplied
  // tenant: scope comes only from app_current_tenant_id() / app_current_user_id().
  // Exceptions: lookups that by design run before any tenant or user is known (login).
  const PRE_CONTEXT_AUTH_LOOKUPS = [
    'auth_find_user_for_login',
    'auth_resolve_tenant',
    'auth_find_refresh_token',
  ];

  it('no SECURITY DEFINER function takes a tenant id parameter', async () => {
    const rows = await app.$queryRaw<{ fn: string; args: string }[]>`
      SELECT p.proname AS fn, pg_get_function_arguments(p.oid) AS args
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef`;
    expect(rows.length).toBeGreaterThan(0);
    const offenders = rows.filter((r) => /tenant/i.test(r.args) || /\buuid\b/i.test(r.args));
    expect(offenders).toEqual([]);
  });

  it('every SECURITY DEFINER function (except pre-context auth lookups) is scoped by context', async () => {
    const rows = await app.$queryRaw<{ fn: string; scoped: boolean }[]>`
      SELECT p.proname AS fn,
             (p.prosrc LIKE '%app_current_tenant_id()%' OR p.prosrc LIKE '%app_current_user_id()%') AS scoped
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
        AND p.proname <> ALL(${PRE_CONTEXT_AUTH_LOOKUPS})`;
    expect(rows.map((r) => r.fn).sort()).toEqual([
      'app_find_or_create_user',
      'auth_list_my_memberships',
      'search_student_ids',
    ]);
    expect(rows.filter((r) => !r.scoped)).toEqual([]);
  });
});

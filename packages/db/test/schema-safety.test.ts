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
        'tenant_subscriptions',
        'platform_invoices',
        'platform_invoice_lines',
        'platform_payments',
        'onboarding_progress',
        'appearance_settings',
        'fee_settings',
        'fee_heads',
        'fee_terms',
        'fee_amounts',
        'fee_concessions',
        'fee_sibling_groups',
        'fee_sibling_members',
        'fee_dues',
        'fee_fine_waivers',
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

  // A SECURITY DEFINER function runs with its owner's rights. Without an explicit search_path, or
  // with pg_temp not last, a caller's temporary table (or function) named like a real one would be
  // found first and could feed it fake rows (e.g. a fake session). Every one must pin exactly this.
  it('every SECURITY DEFINER function pins search_path with pg_temp last, and PUBLIC cannot run it', async () => {
    const rows = await app.$queryRaw<
      { fn: string; config: string[] | null; public_exec: boolean }[]
    >`
      SELECT p.oid::regprocedure::text AS fn, p.proconfig AS config,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef`;
    expect(rows.length).toBeGreaterThanOrEqual(15);
    const unsafe = rows.filter(
      (r) => !(r.config ?? []).includes('search_path=pg_catalog, public, pg_temp'),
    );
    expect(unsafe.map((r) => r.fn)).toEqual([]);
    expect(rows.filter((r) => r.public_exec).map((r) => r.fn)).toEqual([]);
  });

  // Platform functions (Jantrik's own admins) are checked separately below: they may take an
  // institute id, because they only ever run for a live platform session.
  const isPlatform = (fn: string) =>
    fn.startsWith('platform_') || fn === 'app_current_platform_admin_id';

  it('no SECURITY DEFINER function takes a tenant id parameter', async () => {
    const all = await app.$queryRaw<{ fn: string; args: string }[]>`
      SELECT p.proname AS fn, pg_get_function_arguments(p.oid) AS args
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef`;
    const rows = all.filter((r) => !isPlatform(r.fn));
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
    const scoped = rows.filter((r) => !isPlatform(r.fn));
    expect(scoped.map((r) => r.fn).sort()).toEqual([
      'app_find_or_create_user',
      'auth_list_my_memberships',
      'search_student_ids',
    ]);
    expect(scoped.filter((r) => !r.scoped)).toEqual([]);
  });

  // The login steps run before a platform session exists (the API has checked the password and
  // the second factor). Everything else needs a live session of an active admin.
  const PRE_SESSION_PLATFORM = [
    'platform_find_admin_for_login',
    'platform_complete_login',
    'platform_audit_login_failure',
    'platform_session_admin',
  ];

  it('every platform function is owned by jantrik_platform and (after login) needs a session', async () => {
    const rows = await app.$queryRaw<
      { fn: string; owner: string; scoped: boolean; temp_last: boolean }[]
    >`
      SELECT p.proname AS fn, r.rolname AS owner,
             p.prosrc LIKE '%app_current_platform_admin_id()%' AS scoped,
             -- pg_temp searched last: a temp table cannot shadow a platform table.
             'search_path=pg_catalog, public, pg_temp' = ANY(p.proconfig) AS temp_last
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
        AND (p.proname LIKE 'platform\_%' OR p.proname = 'app_current_platform_admin_id')`;
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(rows.filter((r) => r.owner !== 'jantrik_platform')).toEqual([]);
    expect(rows.filter((r) => !r.temp_last)).toEqual([]);
    const needSession = rows.filter(
      (r) => r.fn !== 'app_current_platform_admin_id' && !PRE_SESSION_PLATFORM.includes(r.fn),
    );
    expect(needSession.filter((r) => !r.scoped)).toEqual([]);
  });

  // By owner, not by name: a new platform function whose migration copies an old
  // `GRANT EXECUTE … TO jantrik_app` fails here.
  it('only jantrik_platform_app may run functions owned by jantrik_platform', async () => {
    const rows = await app.$queryRaw<
      { fn: string; app_exec: boolean; platform_exec: boolean; public_exec: boolean }[]
    >`
      SELECT p.oid::regprocedure::text AS fn,
             has_function_privilege('jantrik_app', p.oid, 'EXECUTE') AS app_exec,
             has_function_privilege('jantrik_platform_app', p.oid, 'EXECUTE') AS platform_exec,
             COALESCE(EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                              WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'), true)
               AS public_exec
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proowner = 'jantrik_platform'::regrole`;
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(rows.filter((r) => r.app_exec || r.public_exec || !r.platform_exec)).toEqual([]);
  });
});

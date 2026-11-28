import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/index.js';
import { appClient, ownerClient, tenantTableNames } from './helpers.js';

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
        'fee_receipt_counters',
        'fee_payments',
        'fee_payment_allocations',
        'fee_mobile_accounts',
        'fee_mobile_submissions',
        'fee_mobile_submission_dues',
        'subject_components',
        'subject_pass_groups',
        'section_subject_teachers',
        'student_subject_choices',
        'exam_rooms',
        'exams',
        'exam_classes',
        'exam_subjects',
        'exam_subject_components',
        'exam_subject_pass_groups',
        'exam_candidates',
        'exam_mark_sheets',
        'exam_marks',
        'exam_results',
        'attendance_devices',
        'device_people',
        'device_commands',
        'device_punches',
        'device_source_ips',
        'staff_attendance_days',
        'stored_files',
        'stored_file_usage',
        'institute_profiles',
        'admission_cycles',
        'admission_cycle_classes',
        'admission_applications',
        'admission_application_photos',
        'admission_counters',
        'notices',
        'notice_targets',
        'notice_reads',
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

  // P1-J: every definer function a runtime login may run whose owner can read
  // users.password_hash ("login: function"). Each was checked to return nothing of the hash.
  const PASSWORD_READING_OWNER_FUNCTIONS = [
    'jantrik_app: app_context_key_id', // a one-way fingerprint of the context key (P1-J8)
    'jantrik_app: app_find_or_create_user', // the id only
    'jantrik_app: app_verified_context', // the caller's own verified institute and person (P1-J8)
    'jantrik_app: auth_find_refresh_token', // the token's session and user ids
    'jantrik_app: auth_find_user_for_login', // id, name, locale
    'jantrik_app: auth_list_my_memberships', // memberships of the verified person
    'jantrik_app: auth_my_password_is_set', // a boolean for the verified person (P1-J2)
    'jantrik_app: auth_resolve_tenant', // the institute of a slug
    'jantrik_login_app: auth_context_key', // the request context key (P1-J8), not the hash
    'jantrik_login_app: auth_find_user_for_password_login', // the hash: the password login only
  ];
  // Whole-row patterns of a users row (u.*, to_jsonb(u), row_to_json(u), ...) in a function body.
  const WHOLE_ROW_SQL = String.raw`\mu\.\*|\m(to_jsonb|to_json|row_to_json|jsonb_build_object|json_build_object|hstore)\s*\(\s*u\M`;

  // SECURITY DEFINER functions see past RLS, so they must never trust a caller-supplied
  // tenant: scope comes only from app_current_tenant_id() / app_current_user_id().
  // Exceptions: lookups that by design run before any tenant or user is known (login).
  const PRE_CONTEXT_AUTH_LOOKUPS = [
    'auth_find_user_for_login',
    'auth_find_user_for_password_login',
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
  // So are the device receiver's: no context at all, scoped by the device's serial number.
  const isIngest = (fn: string) => fn.startsWith('ingest_');
  // And the request context itself (P1-J8): the one reader of app.context, and the key's reader
  // for the password-login login.
  const isContext = (fn: string) =>
    ['app_verified_context', 'auth_context_key', 'app_context_key_id'].includes(fn);
  // And the public admission form's (sprint 1 P3b): no context at all, scoped by the slug.
  const isAdmission = (fn: string) => fn.startsWith('admission_');
  // admission_submit takes a cycle class id: it is checked against the slug's institute inside
  // (another institute's class is CLOSED, admission-functions.test.ts).
  const ADMISSION_UUID_ARGS = ['admission_submit'];

  it('no SECURITY DEFINER function takes a tenant id parameter', async () => {
    // Parameters it takes: OUT parameters are results (app_verified_context() returns an
    // institute and a person, it takes none).
    const all = await app.$queryRaw<{ fn: string; args: string }[]>`
      SELECT p.proname AS fn, pg_get_function_arguments(p.oid) AS args
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef`;
    const rows = all
      .filter((r) => !isPlatform(r.fn) && !ADMISSION_UUID_ARGS.includes(r.fn))
      .map((r) => ({
        fn: r.fn,
        args: r.args
          .split(',')
          .filter((a) => !/^\s*OUT\s/i.test(a))
          .join(','),
      }));
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
    const scoped = rows.filter(
      (r) => !isPlatform(r.fn) && !isIngest(r.fn) && !isContext(r.fn) && !isAdmission(r.fn),
    );
    expect(scoped.map((r) => r.fn).sort()).toEqual([
      'app_find_or_create_user',
      'auth_list_my_memberships',
      'auth_my_password_is_set',
      'search_student_ids',
    ]);
    expect(scoped.filter((r) => !r.scoped)).toEqual([]);
  });

  // P1-J8: the context functions check a signature, so every policy, function and view calls them
  // as a scalar subquery, `(SELECT app_current_tenant_id())`: PostgreSQL then runs them once per
  // statement (an InitPlan) instead of once per row a scan looks at. Column defaults and CHECKs
  // (which cannot hold a subquery) must not call them at all, and nothing but the two functions
  // calls app_verified_context() itself. Spaces, quoted names and a schema prefix are caught too.
  const UNWRAPPED_CONTEXT_CALLS = `
    SELECT 'policy ' || c.relname || '.' || p.polname AS what
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE regexp_replace(coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
                         coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                         $1, '', 'gi') ~* $2
    UNION ALL
    SELECT 'function ' || p.proname
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname NOT IN ('app_current_tenant_id', 'app_current_user_id', 'app_verified_context')
      AND regexp_replace(p.prosrc, $1, '', 'gi') ~* $2
    UNION ALL
    SELECT 'view ' || v.viewname FROM pg_views v
    WHERE v.schemaname = 'public' AND regexp_replace(v.definition, $1, '', 'gi') ~* $2
    UNION ALL
    SELECT 'default ' || c.relname || '.' || a.attname
    FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE c.relnamespace = 'public'::regnamespace AND pg_get_expr(d.adbin, d.adrelid) ~* $3
    UNION ALL
    SELECT 'constraint ' || c.relname || '.' || k.conname
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
    WHERE c.relnamespace = 'public'::regnamespace AND k.contype = 'c'
      AND pg_get_constraintdef(k.oid) ~* $3
    ORDER BY 1`;
  const NAME = String.raw`"?app_current_(tenant|user)_id"?\s*\(\s*\)`;
  const WRAPPED_CALL = String.raw`\(\s*SELECT\s+("?public"?\.)?${NAME}(\s+AS\s+"?\w+"?)?\s*\)`;
  const BARE_CALL = String.raw`${NAME}|"?app_verified_context"?\s*\(`;
  const ANY_CALL = String.raw`app_current_(tenant|user)_id|app_verified_context`;
  const unwrappedCalls = (client: PrismaClient) =>
    client.$queryRawUnsafe<{ what: string }[]>(
      UNWRAPPED_CONTEXT_CALLS,
      WRAPPED_CALL,
      BARE_CALL,
      ANY_CALL,
    );

  it('every policy, function and view calls the context functions wrapped, once per statement', async () => {
    expect(await unwrappedCalls(app)).toEqual([]);
  });

  it('the wrapped-call check finds an unwrapped call, in every form and place', async () => {
    const owner = ownerClient();
    class Rollback extends Error {}
    let found: unknown;
    try {
      await owner.$transaction(async (tx) => {
        for (const sql of [
          `CREATE FUNCTION p1j8_probe() RETURNS uuid LANGUAGE sql AS 'SELECT app_current_tenant_id()'`,
          'CREATE POLICY p1j8_probe ON students FOR SELECT USING (tenant_id = app_current_tenant_id())',
          `CREATE FUNCTION p1j8_probe_space() RETURNS uuid LANGUAGE sql AS 'SELECT "app_current_user_id" ( )'`,
          `CREATE FUNCTION p1j8_probe_direct() RETURNS uuid LANGUAGE sql AS 'SELECT (public.app_verified_context()).tenant_id'`,
          'CREATE VIEW p1j8_probe_view AS SELECT id FROM students WHERE tenant_id = app_current_tenant_id()',
          'ALTER TABLE grade_bands ADD COLUMN p1j8_probe uuid DEFAULT app_current_tenant_id()',
          'ALTER TABLE grade_bands ADD CONSTRAINT p1j8_probe CHECK (tenant_id = app_current_tenant_id()) NOT VALID',
        ]) {
          await tx.$executeRawUnsafe(sql);
        }
        found = await unwrappedCalls(tx as unknown as PrismaClient);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    } finally {
      await owner.$disconnect();
    }
    expect(found).toEqual([
      { what: 'constraint grade_bands.p1j8_probe' },
      { what: 'default grade_bands.p1j8_probe' },
      { what: 'function p1j8_probe' },
      { what: 'function p1j8_probe_direct' },
      { what: 'function p1j8_probe_space' },
      { what: 'policy students.p1j8_probe' },
      { what: 'view p1j8_probe_view' },
    ]);
  });

  // P1-J: only the password login's own login reads a password hash. jantrik_app may read every
  // other users column, granted one by one: a new column without its GRANT fails here (whole-row
  // reads of users, e.g. the refresh and /me, would otherwise fail at runtime).
  it('the app login reads every users column but password_hash, with no table-level SELECT', async () => {
    const [table] = await app.$queryRaw<{ table_select: boolean }[]>`
      SELECT has_table_privilege('jantrik_app', 'users', 'SELECT') AS table_select`;
    expect(table).toEqual({ table_select: false });
    const columns = await app.$queryRaw<{ col: string; readable: boolean }[]>`
      SELECT a.attname::text AS col,
             has_column_privilege('jantrik_app', 'users', a.attname, 'SELECT') AS readable
      FROM pg_attribute a
      WHERE a.attrelid = 'users'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attname`;
    expect(columns.length).toBeGreaterThanOrEqual(10);
    expect(columns.filter((c) => c.readable !== (c.col !== 'password_hash'))).toEqual([]);
  });

  it('no login role but the owner, and not PUBLIC, may read users.password_hash', async () => {
    const readers = await app.$queryRaw<{ name: string }[]>`
      SELECT r.rolname::text AS name
      FROM pg_roles r
      WHERE r.rolcanlogin AND NOT r.rolsuper
        AND r.oid <> (SELECT relowner FROM pg_class WHERE oid = 'users'::regclass)
        AND has_column_privilege(r.oid, 'users'::regclass, 'password_hash', 'SELECT')
      UNION ALL
      SELECT 'PUBLIC' WHERE has_column_privilege('public', 'users', 'password_hash', 'SELECT')`;
    expect(readers).toEqual([]);
  });

  // Nor through a view: a view runs with its owner's rights (and a whole-row `u.*` view
  // depends on every column), so no view or materialised view may read the hash.
  const VIEWS_READING_HASH = `
    SELECT DISTINCT r.ev_class::regclass::text AS view
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    WHERE d.classid = 'pg_rewrite'::regclass
      AND d.refclassid = 'pg_class'::regclass
      AND d.refobjid = 'users'::regclass
      AND d.refobjsubid = (SELECT attnum FROM pg_attribute
                           WHERE attrelid = 'users'::regclass AND attname = 'password_hash')`;

  it('no view or materialised view reads users.password_hash', async () => {
    expect(await app.$queryRawUnsafe(VIEWS_READING_HASH)).toEqual([]);
  });

  it('the view check finds a whole-row view of users', async () => {
    const owner = ownerClient();
    class Rollback extends Error {}
    let found: unknown;
    try {
      await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('CREATE VIEW p1j_probe AS SELECT u.* FROM users u');
        found = await tx.$queryRawUnsafe(VIEWS_READING_HASH);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    } finally {
      await owner.$disconnect();
    }
    expect(found).toEqual([{ view: 'p1j_probe' }]);
  });

  // The hash must not come back through a definer function either. Every function a runtime login
  // may run whose owner can read password_hash is pinned by name: adding one is a deliberate change
  // here, after checking that it returns nothing of the hash.
  const RUNTIME_LOGINS = [
    'jantrik_app',
    'jantrik_platform_app',
    'jantrik_ingest_app',
    'jantrik_login_app',
  ];

  it('the definer functions a runtime login may run, whose owner can read password_hash, are pinned', async () => {
    const rows = await app.$queryRaw<{ entry: string }[]>`
      SELECT r.login || ': ' || p.proname AS entry
      FROM pg_proc p
      CROSS JOIN unnest(${RUNTIME_LOGINS}::text[]) AS r(login)
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
        AND has_function_privilege(r.login, p.oid, 'EXECUTE')
        AND has_column_privilege(p.proowner, 'users'::regclass, 'password_hash', 'SELECT')
      ORDER BY 1`;
    expect(rows.map((r) => r.entry)).toEqual(PASSWORD_READING_OWNER_FUNCTIONS);
  });

  it('only the password lookup returns password_hash (or a whole users row), and only the login login may run it', async () => {
    const rows = await app.$queryRaw<{ fn: string; result: string; runners: string[] }[]>`
      SELECT p.proname::text AS fn, pg_get_function_result(p.oid) AS result,
             ARRAY(SELECT r FROM unnest(${RUNTIME_LOGINS}::text[]) AS r
                   WHERE has_function_privilege(r, p.oid, 'EXECUTE') ORDER BY 1) AS runners
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
        AND (pg_get_function_result(p.oid) ILIKE '%password_hash%'
             OR p.prorettype = 'users'::regtype
             OR p.prosrc ~* ${WHOLE_ROW_SQL})
      ORDER BY 1`;
    expect(rows).toEqual([
      {
        fn: 'auth_find_user_for_password_login',
        result: 'TABLE(id uuid, name text, locale locale, password_hash text)',
        runners: ['jantrik_login_app'],
      },
      // The platform admins' own login (platform_admins.password_hash, not users'; P1-J6): only
      // the platform module's login may run it.
      {
        fn: 'platform_find_admin_for_login',
        result:
          'TABLE(id uuid, name text, password_hash text, is_active boolean, totp_secret text, totp_enrol_by timestamp with time zone)',
        runners: ['jantrik_platform_app'],
      },
    ]);
  });

  // The password login's own login: like the receiver's, it reaches the database only through its
  // two functions (the hash lookup, and since P1-J8 the request context key), never a table, and
  // is a member of no role.
  it('jantrik_login_app may run only the password lookup and the context key, and holds no other privilege', async () => {
    const granted = await app.$queryRaw<{ name: string }[]>`
      SELECT c.relname::text AS name
      FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND CASE WHEN c.relkind = 'S'
                 THEN has_sequence_privilege('jantrik_login_app', c.oid, 'USAGE, SELECT, UPDATE')
                 ELSE has_table_privilege('jantrik_login_app', c.oid,
                        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                   OR has_any_column_privilege('jantrik_login_app', c.oid,
                        'SELECT, INSERT, UPDATE, REFERENCES')
            END
      UNION ALL
      SELECT p.proname::text
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname <> ALL (ARRAY['auth_find_user_for_password_login', 'auth_context_key'])
        AND has_function_privilege('jantrik_login_app', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('public', p.oid, 'EXECUTE')`;
    expect(granted).toEqual([]);
    const [role] = await app.$queryRaw<
      { superuser: boolean; bypassrls: boolean; roles: string[]; owned: bigint }[]
    >`
      SELECT r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
             ARRAY(SELECT m.roleid::regrole::text FROM pg_auth_members m
                   WHERE m.member = r.oid) AS roles,
             (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid) AS owned
      FROM pg_roles r WHERE r.rolname = 'jantrik_login_app'`;
    expect(role).toEqual({ superuser: false, bypassrls: false, roles: [], owned: 0n });
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

  // The definer bodies use unqualified pg_catalog operators (enum =, text[] || text, …). A more
  // specific operator or function created in public would win over them, so no login role may
  // create anything there (only the NOLOGIN function owners may).
  // P1-J8 review: a temporary object made through an SQL injection outlives the request on a
  // pooled connection, and pg_temp is searched first for relations. No runtime login may create
  // one (the migration revokes TEMPORARY from PUBLIC; the owner keeps it).
  it('no runtime login may create temporary objects', async () => {
    const rows = await app.$queryRaw<{ login: string; temp: boolean }[]>`
      SELECT r AS login, has_database_privilege(r, current_database(), 'TEMPORARY') AS temp
      FROM unnest(${RUNTIME_LOGINS}::text[]) AS r ORDER BY 1`;
    expect(rows.filter((r) => r.temp)).toEqual([]);
    expect(rows).toHaveLength(RUNTIME_LOGINS.length);
  });

  it('no login role can create objects in schema public', async () => {
    const rows = await app.$queryRaw<{ role: string; can_create: boolean }[]>`
      SELECT r.rolname AS role, has_schema_privilege(r.oid, 'public', 'CREATE') AS can_create
      FROM pg_roles r
      WHERE r.rolname IN ('jantrik_app', 'jantrik_ingest_app', 'jantrik_platform_app')
      ORDER BY 1`;
    expect(rows).toEqual([
      { role: 'jantrik_app', can_create: false },
      { role: 'jantrik_ingest_app', can_create: false },
      { role: 'jantrik_platform_app', can_create: false },
    ]);
  });

  // The device receiver (jantrik_ingest_app) runs these four SECURITY DEFINER functions; any other
  // function owned by jantrik_ingest is a helper that only they call, running as its caller.
  const INGEST_ENTRY_POINTS = [
    'ingest_command_results',
    'ingest_resolve',
    'ingest_store_punches',
    'ingest_take_commands',
  ];

  // By name and by owner: an ingest_* function owned by someone else would escape the context
  // check above, and a jantrik_ingest function under another name would escape this one.
  it('every ingest function is owned by jantrik_ingest, pins search_path and takes no tenant or uuid', async () => {
    const rows = await app.$queryRaw<
      { fn: string; owner: string; definer: boolean; temp_last: boolean; args: string }[]
    >`
      SELECT p.proname AS fn, r.rolname AS owner, p.prosecdef AS definer,
             'search_path=pg_catalog, public, pg_temp' = ANY(p.proconfig) AS temp_last,
             pg_get_function_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.pronamespace = 'public'::regnamespace
        AND (p.proname LIKE 'ingest\_%' OR p.proowner = 'jantrik_ingest'::regrole)`;
    expect(
      rows
        .filter((r) => r.definer)
        .map((r) => r.fn)
        .sort(),
    ).toEqual(INGEST_ENTRY_POINTS);
    expect(rows.filter((r) => r.owner !== 'jantrik_ingest')).toEqual([]);
    expect(rows.filter((r) => !r.temp_last)).toEqual([]);
    expect(rows.filter((r) => /tenant/i.test(r.args) || /\buuid\b/i.test(r.args))).toEqual([]);
  });

  // By owner, like the platform check: a migration that copies `GRANT EXECUTE … TO jantrik_app`
  // fails here.
  it('only jantrik_ingest_app may run the ingest functions, and nobody the helpers', async () => {
    const rows = await app.$queryRaw<
      {
        fn: string;
        app_exec: boolean;
        platform_exec: boolean;
        ingest_exec: boolean;
        public_exec: boolean;
      }[]
    >`
      SELECT p.proname AS fn,
             has_function_privilege('jantrik_app', p.oid, 'EXECUTE') AS app_exec,
             has_function_privilege('jantrik_platform_app', p.oid, 'EXECUTE') AS platform_exec,
             has_function_privilege('jantrik_ingest_app', p.oid, 'EXECUTE') AS ingest_exec,
             COALESCE(EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                              WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'), true)
               AS public_exec
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proowner = 'jantrik_ingest'::regrole`;
    expect(rows.length).toBeGreaterThan(INGEST_ENTRY_POINTS.length);
    expect(
      rows.filter(
        (r) =>
          r.app_exec ||
          r.platform_exec ||
          r.public_exec ||
          r.ingest_exec !== INGEST_ENTRY_POINTS.includes(r.fn),
      ),
    ).toEqual([]);
  });

  // The public admission form (sprint 1 P3b): three definer functions owned by the NOLOGIN
  // jantrik_admission, run by jantrik_app only, and that role's grants exactly as written.
  const ADMISSION_FUNCTIONS = ['admission_lookup', 'admission_public_form', 'admission_submit'];

  it('every admission function is owned by jantrik_admission, pins search_path, and only jantrik_app may run it', async () => {
    const rows = await app.$queryRaw<
      {
        fn: string;
        owner: string;
        definer: boolean;
        temp_last: boolean;
        app_exec: boolean;
        platform_exec: boolean;
        ingest_exec: boolean;
        login_exec: boolean;
        public_exec: boolean;
      }[]
    >`
      SELECT p.proname AS fn, r.rolname AS owner, p.prosecdef AS definer,
             'search_path=pg_catalog, public, pg_temp' = ANY(p.proconfig) AS temp_last,
             has_function_privilege('jantrik_app', p.oid, 'EXECUTE') AS app_exec,
             has_function_privilege('jantrik_platform_app', p.oid, 'EXECUTE') AS platform_exec,
             has_function_privilege('jantrik_ingest_app', p.oid, 'EXECUTE') AS ingest_exec,
             has_function_privilege('jantrik_login_app', p.oid, 'EXECUTE') AS login_exec,
             COALESCE(EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                              WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'), true)
               AS public_exec
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.pronamespace = 'public'::regnamespace
        AND (p.proname LIKE 'admission\_%' OR p.proowner = 'jantrik_admission'::regrole)`;
    expect(rows.map((r) => r.fn).sort()).toEqual(ADMISSION_FUNCTIONS);
    expect(
      rows.filter(
        (r) =>
          r.owner !== 'jantrik_admission' ||
          !r.definer ||
          !r.temp_last ||
          !r.app_exec ||
          r.platform_exec ||
          r.ingest_exec ||
          r.login_exec ||
          r.public_exec,
      ),
    ).toEqual([]);
  });

  it('jantrik_admission: NOLOGIN, no login is a member, the owner may SET ROLE to it but not inherit it', async () => {
    const [role] = await app.$queryRaw<
      { login: boolean; superuser: boolean; bypassrls: boolean; members: string[] }[]
    >`
      SELECT r.rolcanlogin AS login, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
             ARRAY(SELECT m.rolname || ':' || a.inherit_option || ':' || a.set_option
                   FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member
                   WHERE a.roleid = r.oid ORDER BY 1)::text[] AS members
      FROM pg_roles r WHERE r.rolname = 'jantrik_admission'`;
    expect(role).toEqual({
      login: false,
      superuser: false,
      bypassrls: false,
      members: ['jantrik_owner:false:true'],
    });
  });

  // A snapshot: widening what the public form's functions may touch fails here.
  it("jantrik_admission's table and column privileges are exactly the plan's", async () => {
    // From the catalogs: information_schema shows only the grants the current login may see.
    const rows = await app.$queryRaw<{ grant: string }[]>`
      SELECT c.relname || ':' || a.privilege_type || ':' || att.attname AS grant
      FROM pg_class c
      JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
      CROSS JOIN LATERAL aclexplode(att.attacl) a
      WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 'jantrik_admission'::regrole
      UNION
      SELECT c.relname || ':' || a.privilege_type || ':*'
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 'jantrik_admission'::regrole
      ORDER BY 1`;
    // Every table:privilege with its columns ('*' = the whole table), exactly: any widening, a
    // column or a whole-table grant, fails here (review of P3b, S5).
    const got: Record<string, string[]> = {};
    for (const { grant } of rows) {
      const [table, privilege, column] = grant.split(':') as [string, string, string];
      (got[`${table}:${privilege}`] ??= []).push(column);
    }
    for (const k of Object.keys(got)) got[k]!.sort();
    const cols = (...c: string[]) => [...c].sort();
    expect(got).toEqual({
      'tenants:SELECT': cols('default_locale', 'id', 'name', 'slug', 'status', 'timezone'),
      'institute_profiles:SELECT': cols('name_bn', 'name_en', 'tenant_id'),
      'academic_years:SELECT': cols('id', 'start_date', 'tenant_id'),
      'class_levels:SELECT': cols(
        'id',
        'is_active',
        'name_bn',
        'name_en',
        'sort_order',
        'tenant_id',
      ),
      'study_groups:SELECT': cols(
        'id',
        'is_active',
        'name_bn',
        'name_en',
        'sort_order',
        'tenant_id',
      ),
      'admission_cycles:SELECT': ['*'],
      'admission_cycle_classes:SELECT': ['*'],
      'admission_applications:SELECT': cols(
        'application_no',
        'birth_registration_no',
        'cycle_class_id',
        'cycle_id',
        'date_of_birth',
        'id',
        'name_bn',
        'name_en',
        'name_key',
        'phone',
        'status',
        'submitted_at',
        'tenant_id',
      ),
      'admission_applications:INSERT': cols(
        'id',
        'tenant_id',
        'cycle_id',
        'cycle_class_id',
        'application_no',
        'source',
        'name_bn',
        'name_en',
        'name_key',
        'date_of_birth',
        'gender',
        'religion',
        'blood_group',
        'birth_registration_no',
        'previous_institute',
        'present_address',
        'permanent_address',
        'father_name_bn',
        'father_name_en',
        'mother_name_bn',
        'mother_name_en',
        'guardian_name_bn',
        'guardian_name_en',
        'guardian_relation',
        'guardian_occupation',
        'phone',
        'submitted_at',
        'created_at',
        'updated_at',
      ),
      'admission_application_photos:INSERT': ['*'],
      'admission_counters:SELECT': ['*'],
      'admission_counters:INSERT': ['*'],
      'admission_counters:UPDATE': cols('last_no', 'updated_at'),
    });
  });

  // The receiver parses internet input without a login: whatever it does goes through the
  // functions above, never a table or another definer function.
  it('jantrik_ingest_app has no privilege on any table, column or sequence, and no role', async () => {
    const granted = await app.$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name
      FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        -- CASE: has_sequence_privilege raises on a non-sequence, whatever the order.
        AND CASE WHEN c.relkind = 'S'
                 THEN has_sequence_privilege('jantrik_ingest_app', c.oid, 'USAGE, SELECT, UPDATE')
                 ELSE has_table_privilege('jantrik_ingest_app', c.oid,
                        'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                   OR has_any_column_privilege('jantrik_ingest_app', c.oid,
                        'SELECT, INSERT, UPDATE, REFERENCES')
            END
      UNION ALL
      SELECT p.proname
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
        AND p.proowner <> 'jantrik_ingest'::regrole
        AND has_function_privilege('jantrik_ingest_app', p.oid, 'EXECUTE')`;
    expect(granted).toEqual([]);
    const [role] = await app.$queryRaw<
      { superuser: boolean; bypassrls: boolean; roles: string[]; owned: bigint }[]
    >`
      SELECT r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
             ARRAY(SELECT m.roleid::regrole::text FROM pg_auth_members m
                   WHERE m.member = r.oid) AS roles,
             (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid) AS owned
      FROM pg_roles r WHERE r.rolname = 'jantrik_ingest_app'`;
    expect(role).toEqual({ superuser: false, bypassrls: false, roles: [], owned: 0n });
  });
});

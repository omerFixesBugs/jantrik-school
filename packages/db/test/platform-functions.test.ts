import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPlatformToken, withPlatformSession, type PrismaClient } from '../src/index.js';
import { appClient, ownerClient, platformClient, randomPhone } from './helpers.js';

// Platform admins are Jantrik staff, not institute users. Their tables are reachable only through
// jantrik_platform's SECURITY DEFINER functions, which only the API platform module's own login
// role (jantrik_platform_app) may run; those (except the login steps) refuse without a live
// session. jantrik_app, the rest of the API, can run none of them. See docs/platform.md.

const FUNCTIONS = [
  'app_current_platform_admin_id',
  'platform_find_admin_for_login',
  'platform_complete_login',
  'platform_audit_login_failure',
  'platform_session_admin',
  'platform_end_session',
  'platform_me',
  'platform_audit',
  'platform_list_audit',
];
const TABLES = [
  'platform_admins',
  'platform_admin_backup_codes',
  'platform_sessions',
  'platform_audit_logs',
];
const IDLE = 1800;
const MAX = 8 * 3600;
const PASSWORD_HASH = 'not-a-real-hash';
const SECRET = 'v1.test';
const nowStep = () => BigInt(Math.floor(Date.now() / 30_000));

describe('platform tables and functions', () => {
  let app: PrismaClient;
  let platform: PrismaClient;
  let owner: PrismaClient;

  /** An enrolled admin (as the owner role, like the seed and the CLI). */
  const newAdmin = async (data: { totpSecret?: string | null; totpEnrolBy?: Date } = {}) =>
    (
      await owner.platformAdmin.create({
        data: {
          name: 'Platform Tester',
          phone: randomPhone(),
          passwordHash: PASSWORD_HASH,
          totpSecret: SECRET,
          totpEnabledAt: new Date(),
          ...data,
          ...(data.totpSecret === null ? { totpEnabledAt: null } : {}),
        },
      })
    ).id;

  /** Open a session through the login function, as the API does after both factors. */
  const login = async (
    adminId: string,
    opts: { step?: bigint; method?: string; password?: string; secret?: string | null } = {},
  ): Promise<string> => {
    const token = randomBytes(32).toString('base64url');
    await platform.$queryRaw`SELECT platform_complete_login(${adminId}::uuid, ${opts.method ?? 'TOTP'},
      ${opts.step ?? nowStep()}::bigint, NULL,
      ${opts.method === 'ENROL' ? 'v1.new' : null},
      ${opts.method === 'ENROL' ? Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(64, 'a')) : null}::text[],
      ${opts.password ?? PASSWORD_HASH}, ${opts.secret === undefined ? SECRET : opts.secret},
      ${hashPlatformToken(token)}, '127.0.0.1', 'test', ${IDLE}::int, ${MAX}::int)::text`;
    return token;
  };
  const me = (token: string) =>
    withPlatformSession(
      platform,
      hashPlatformToken(token),
      (tx) => tx.$queryRaw<{ name: string; phone: string }[]>`SELECT * FROM platform_me()`,
    );

  beforeAll(() => {
    app = appClient();
    platform = platformClient();
    owner = ownerClient();
  });

  afterAll(async () => {
    await Promise.all([app.$disconnect(), platform.$disconnect(), owner.$disconnect()]);
  });

  it('the app role cannot read or write any platform table directly', async () => {
    for (const table of TABLES) {
      await expect(app.$queryRawUnsafe(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(app.$executeRawUnsafe(`DELETE FROM ${table}`)).rejects.toThrow(
        /permission denied/i,
      );
    }
  });

  it('every platform function is owned by jantrik_platform, searches pg_temp last, and runs only for the platform role', async () => {
    const rows = await app.$queryRaw<
      {
        fn: string;
        owner: string;
        config: string[] | null;
        definer: boolean;
        public_exec: boolean;
        app_exec: boolean;
        platform_exec: boolean;
      }[]
    >`
      SELECT p.proname AS fn, r.rolname AS owner, p.proconfig AS config, p.prosecdef AS definer,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
             has_function_privilege('jantrik_app', p.oid, 'EXECUTE') AS app_exec,
             has_function_privilege('jantrik_platform_app', p.oid, 'EXECUTE') AS platform_exec
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY(${FUNCTIONS})`;
    expect(rows.map((r) => r.fn).sort()).toEqual([...FUNCTIONS].sort());
    for (const r of rows) {
      expect(r, r.fn).toMatchObject({
        owner: 'jantrik_platform',
        definer: true,
        app_exec: false,
        platform_exec: true,
        public_exec: false,
      });
      expect(r.config, r.fn).toContain('search_path=pg_catalog, public, pg_temp');
    }
  });

  it('the rest of the API (jantrik_app) can run none of them: no session, no audit entry', async () => {
    const calls = [
      app.$queryRaw`SELECT * FROM platform_find_admin_for_login('+8801700000001', NULL)`,
      app.$queryRaw`SELECT * FROM platform_session_admin(${'0'.repeat(64)}, 1800)`,
      app.$queryRaw`SELECT app_current_platform_admin_id()`,
      app.$executeRaw`SELECT platform_audit_login_failure(${'00000000-0000-4000-8000-000000000001'}::uuid, 'x', 'y')`,
      app.$queryRaw`SELECT platform_complete_login(${'00000000-0000-4000-8000-000000000001'}::uuid,
        'TOTP', 1::bigint, NULL, NULL, NULL, 'h', 's', ${'0'.repeat(64)}, NULL, NULL, 1800, 28800)`,
    ];
    for (const call of calls) await expect(call).rejects.toThrow(/permission denied/i);
  });

  it('the platform role is an ordinary runtime role: no RLS bypass, owns nothing, no platform table grants', async () => {
    const [role] = await platform.$queryRaw<
      { name: string; superuser: boolean; bypassrls: boolean; owned: bigint }[]
    >`
      SELECT r.rolname AS name, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
             (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid) AS owned
      FROM pg_roles r WHERE r.rolname = current_user`;
    expect(role).toEqual({
      name: 'jantrik_platform_app',
      superuser: false,
      bypassrls: false,
      owned: 0n,
    });
    for (const table of TABLES) {
      await expect(platform.$queryRawUnsafe(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toThrow(
        /permission denied/i,
      );
    }
  });

  it('the platform role reaches no institute data: no role membership, no table, no other definer function', async () => {
    const [rights] = await platform.$queryRaw<
      { memberships: bigint; tables: string[]; sequences: string[]; functions: string[] }[]
    >`
      SELECT
        (SELECT count(*) FROM pg_auth_members m WHERE m.member = current_user::regrole)
          AS memberships,
        ARRAY(SELECT c.relname::text FROM pg_class c
              WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
                AND (has_table_privilege(c.oid,
                       'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                  OR has_any_column_privilege(c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')))
          AS tables,
        ARRAY(SELECT c.relname::text FROM pg_class c
              WHERE c.relnamespace = 'public'::regnamespace
                -- CASE: has_sequence_privilege raises on a non-sequence, whatever the order.
                AND CASE WHEN c.relkind = 'S'
                         THEN has_sequence_privilege(c.oid, 'USAGE, SELECT, UPDATE') END)
          AS sequences,
        ARRAY(SELECT p.proname::text FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
                AND p.proowner <> 'jantrik_platform'::regrole
                AND has_function_privilege(p.oid, 'EXECUTE')) AS functions`;
    expect(rights).toEqual({ memberships: 0n, tables: [], sequences: [], functions: [] });
    for (const table of ['tenants', 'students', 'guardians', 'memberships', 'users']) {
      await expect(platform.$queryRawUnsafe(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toThrow(
        /permission denied/i,
      );
    }
  });

  it('a temp table named like a platform table cannot fake a session (pg_temp is searched last)', async () => {
    const fake = '00000000-0000-4000-8000-000000000001';
    await expect(
      platform.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE platform_sessions (admin_id uuid, token_hash text,
          revoked_at timestamptz, expires_at timestamptz, idle_expires_at timestamptz) ON COMMIT DROP`);
        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE platform_admins (id uuid, is_active boolean) ON COMMIT DROP`,
        );
        await tx.$executeRawUnsafe(
          `GRANT ALL ON platform_sessions, platform_admins TO jantrik_platform`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO platform_sessions VALUES ('${fake}', 'x', NULL, now() + interval '1 hour', now() + interval '1 hour')`,
        );
        await tx.$executeRawUnsafe(`INSERT INTO platform_admins VALUES ('${fake}', true)`);
        await tx.$executeRaw`SELECT set_config('app.platform_session', 'x', true)`;
        return tx.$queryRaw`SELECT app_current_platform_admin_id()::text AS id`;
      }),
    ).rejects.toThrow(/platform session required/);
  });

  it('without a session (or with a wrong one) the session functions refuse', async () => {
    await expect(platform.$queryRaw`SELECT * FROM platform_me()`).rejects.toThrow(
      /platform session required/,
    );
    await expect(
      platform.$queryRaw`SELECT * FROM platform_list_audit(NULL, NULL, 10)`,
    ).rejects.toThrow(/platform session required/);
    await expect(
      platform.$queryRaw`SELECT platform_audit('X', NULL, NULL, NULL, NULL, NULL)`,
    ).rejects.toThrow(/platform session required/);
    await expect(
      withPlatformSession(
        platform,
        hashPlatformToken('not-a-session'),
        (tx) => tx.$queryRaw`SELECT * FROM platform_me()`,
      ),
    ).rejects.toThrow(/platform session required/);
  });

  it('login accepts only the current time step, never one twice, and only the credentials it started with', async () => {
    const id = await newAdmin();
    // A step far away (a caller trying to skip the code, or lock the admin out) is refused.
    await expect(login(id, { step: nowStep() + 1000n })).rejects.toThrow(/PLATFORM_CODE_EXPIRED/);
    await expect(login(id, { step: 9223372036854775807n })).rejects.toThrow(
      /PLATFORM_CODE_EXPIRED/,
    );
    const token = await login(id);
    expect((await me(token))[0]).toMatchObject({ name: 'Platform Tester' });
    await expect(login(id)).rejects.toThrow(/PLATFORM_CODE_REUSED/); // replay
    // The password or authenticator changed since the login started (e.g. the CLI).
    await expect(login(id, { step: nowStep() + 1n, password: 'old-hash' })).rejects.toThrow(
      /PLATFORM_CREDENTIALS_CHANGED/,
    );
    await expect(login(id, { step: nowStep() + 1n, secret: 'v1.old' })).rejects.toThrow(
      /PLATFORM_CREDENTIALS_CHANGED/,
    );
  });

  it('a first enrolment works only inside the window the CLI opened', async () => {
    const closed = await newAdmin({ totpSecret: null });
    await expect(login(closed, { method: 'ENROL', secret: null })).rejects.toThrow(
      /PLATFORM_ENROLMENT_CLOSED/,
    );
    const expired = await newAdmin({ totpSecret: null, totpEnrolBy: new Date(Date.now() - 1000) });
    await expect(login(expired, { method: 'ENROL', secret: null })).rejects.toThrow(
      /PLATFORM_ENROLMENT_CLOSED/,
    );
    const open = await newAdmin({ totpSecret: null, totpEnrolBy: new Date(Date.now() + 3600_000) });
    await login(open, { method: 'ENROL', secret: null });
    const row = await owner.platformAdmin.findUniqueOrThrow({ where: { id: open } });
    expect(row).toMatchObject({ totpSecret: 'v1.new', totpEnrolBy: null });
    expect(await owner.platformAdminBackupCode.count({ where: { adminId: open } })).toBe(10);
    // Once set up, enrolling again is refused.
    await expect(
      login(open, { method: 'ENROL', secret: 'v1.new', step: nowStep() + 1n }),
    ).rejects.toThrow(/PLATFORM_ALREADY_ENROLLED/);
  });

  it('a session ends when it idles out, expires, the admin is disabled, or on logout', async () => {
    const idle = await login(await newAdmin());
    const idleHash = hashPlatformToken(idle);
    await owner.$executeRaw`UPDATE platform_sessions SET idle_expires_at = now() - interval '1 second' WHERE token_hash = ${idleHash}`;
    expect(
      await platform.$queryRaw<
        unknown[]
      >`SELECT * FROM platform_session_admin(${idleHash}, ${IDLE}::int)`,
    ).toEqual([]);

    // Idle renewal never goes past the absolute end.
    const capped = hashPlatformToken(await login(await newAdmin()));
    await owner.$executeRaw`UPDATE platform_sessions SET expires_at = now() + interval '10 seconds', idle_expires_at = now() + interval '5 seconds' WHERE token_hash = ${capped}`;
    await platform.$queryRaw`SELECT * FROM platform_session_admin(${capped}, ${IDLE}::int)`;
    const [row] = await owner.$queryRaw<
      { within: boolean }[]
    >`SELECT idle_expires_at <= expires_at AS within FROM platform_sessions WHERE token_hash = ${capped}`;
    expect(row!.within).toBe(true);

    const adminId = await newAdmin();
    const token = await login(adminId);
    await owner.platformAdmin.update({ where: { id: adminId }, data: { isActive: false } });
    await expect(me(token)).rejects.toThrow(/platform session required/);
    await expect(login(adminId, { step: nowStep() + 1n })).rejects.toThrow(
      /PLATFORM_ADMIN_INACTIVE/,
    );
    await owner.platformAdmin.update({ where: { id: adminId }, data: { isActive: true } });

    await withPlatformSession(
      platform,
      hashPlatformToken(token),
      (tx) => tx.$executeRaw`SELECT platform_end_session()`,
    );
    await expect(me(token)).rejects.toThrow(/platform session required/);
    const actions = await owner.platformAuditLog.findMany({
      where: { adminId },
      select: { action: true },
    });
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(['LOGIN', 'LOGOUT']));
  });

  it('the audit log is append-only (also for the platform role) and pages by (time, id)', async () => {
    const token = await login(await newAdmin());
    await withPlatformSession(platform, hashPlatformToken(token), async (tx) => {
      for (let i = 0; i < 3; i++) {
        await tx.$queryRaw`SELECT platform_audit('TEST_ACTION', NULL, 'thing', ${`k${i}`}, '{"a":1}'::jsonb, '127.0.0.1')`;
      }
      // One transaction: the three rows share created_at, yet keyset paging returns each once.
      const first = await tx.$queryRaw<
        { id: string; created_at: Date; entity_id: string }[]
      >`SELECT * FROM platform_list_audit(NULL, NULL, 2)`;
      const last = first.at(-1)!;
      const next = await tx.$queryRaw<
        { entity_id: string }[]
      >`SELECT * FROM platform_list_audit(${last.created_at}::timestamptz, ${last.id}::uuid, 1)`;
      expect([...first, ...next].map((r) => r.entity_id).sort()).toEqual(['k0', 'k1', 'k2']);
    });
    const [grants] = await owner.$queryRaw<{ upd: boolean; del: boolean }[]>`
      SELECT has_table_privilege('jantrik_platform', 'platform_audit_logs', 'UPDATE') AS upd,
             has_table_privilege('jantrik_platform', 'platform_audit_logs', 'DELETE') AS del`;
    expect(grants).toEqual({ upd: false, del: false });
  });
});

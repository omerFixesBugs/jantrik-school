import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPlatformSession, withTenant, type PrismaClient, type TenantTx } from '../src/index.js';
import {
  appClient,
  createStudent,
  createTenant,
  newPlatformSession,
  ownerClient,
  platformClient,
  randomPhone,
} from './helpers.js';

// Institutes from the platform side (step 8, part 2): the platform functions see metadata and
// counts only (column grants), an institute cannot change its own status, modules or plan, and
// every platform write is audited on both sides. See docs/platform.md.

const DENIED = /permission denied/i;

describe('platform institute functions', () => {
  let app: PrismaClient;
  let platform: PrismaClient;
  let owner: PrismaClient;
  let session: { adminId: string; tokenHash: string };

  const asPlatform = <T>(fn: (tx: TenantTx) => Promise<T>) =>
    withPlatformSession(platform, session.tokenHash, fn);
  const detail = (tenantId: string) =>
    asPlatform(async (tx) => {
      const [row] = await tx.$queryRaw<{ v: Record<string, unknown> }[]>`
        SELECT platform_get_institute(${tenantId}::uuid) AS v`;
      return row!.v;
    });
  const register = (tenantId: string, opts: { trialEndsOn?: string | null } = {}) =>
    asPlatform(
      (tx) => tx.$executeRaw`SELECT platform_register_institute(${tenantId}::uuid, 'Standard',
        'PER_STUDENT', 1000, 500, 0, 0, 0, 'MONTHLY', 0, 10, ${opts.trialEndsOn ?? null}::date,
        NULL, NULL, '{"by":"test"}'::jsonb, '127.0.0.1')`,
    );
  const setStatus = (tenantId: string, action: string, reason = 'testing the status') =>
    asPlatform(async (tx) => {
      const [row] = await tx.$queryRaw<{ s: string }[]>`
        SELECT platform_set_institute_status(${tenantId}::uuid, ${action}, ${reason}, '127.0.0.1') AS s`;
      return row!.s;
    });
  const list = (filters: {
    search?: string;
    type?: string;
    status?: string;
    trialEnded?: boolean;
  }) =>
    asPlatform(
      (tx) => tx.$queryRaw<
        {
          id: string;
          name: string;
          status: string;
          owner_name: string | null;
          owner_status: string | null;
          active_students: bigint;
          sms_this_month: bigint;
          total: bigint;
        }[]
      >`SELECT * FROM platform_list_institutes(${filters.search ?? null}, ${filters.type ?? null},
          ${filters.status ?? null}, NULL, ${filters.trialEnded ?? null}::boolean, NULL, 0, 100)`,
    );

  beforeAll(async () => {
    app = appClient();
    platform = platformClient();
    owner = ownerClient();
    session = await newPlatformSession(owner);
  });

  afterAll(async () => {
    await Promise.all([app.$disconnect(), platform.$disconnect(), owner.$disconnect()]);
  });

  it('an institute cannot change its own status, modules or plan', async () => {
    const t = await createTenant(app, { status: 'SUSPENDED' });
    await expect(
      withTenant(app, t.id, (tx) =>
        tx.tenant.update({ where: { id: t.id }, data: { status: 'ACTIVE' } }),
      ),
    ).rejects.toThrow(DENIED);
    await expect(
      withTenant(app, t.id, (tx) => tx.$executeRaw`DELETE FROM tenants WHERE id = ${t.id}::uuid`),
    ).rejects.toThrow(DENIED);
    await expect(
      withTenant(app, t.id, (tx) =>
        tx.tenantModule.updateMany({ data: { enabled: true }, where: {} }),
      ),
    ).rejects.toThrow(DENIED);
    await expect(
      withTenant(app, t.id, (tx) => tx.$executeRaw`DELETE FROM tenant_modules`),
    ).rejects.toThrow(DENIED);
    // Nor add a module row later: only the provisioning insert (no rows yet) may. The policy is
    // checked on the proposed row even when it would conflict.
    await expect(
      withTenant(
        app,
        t.id,
        (tx) => tx.$executeRaw`INSERT INTO tenant_modules (id, tenant_id, module_key, enabled)
          VALUES (gen_random_uuid(), ${t.id}::uuid, 'FEES', true) ON CONFLICT DO NOTHING`,
      ),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      withTenant(app, t.id, (tx) =>
        tx.tenantSubscription.create({ data: { tenantId: t.id, studentLimit: null } }),
      ),
    ).rejects.toThrow(DENIED);
  });

  it('module rows: one provisioning insert, never a later one (even for a module without a row)', async () => {
    const type = await app.instituteType.findFirstOrThrow();
    const id = randomUUID();
    const tenant = (tx: TenantTx) =>
      tx.tenant.create({
        data: { id, slug: `m-${id.slice(0, 8)}`, name: 'Modules', instituteTypeId: type.id },
      });
    // Rows only for CORE, as an institute provisioned before every module got a row.
    await expect(
      withTenant(app, id, async (tx) => {
        await tenant(tx);
        await tx.tenantModule.createMany({ data: [{ tenantId: id, moduleKey: 'CORE' }] });
        // FEES has no row, and still cannot be added.
        await tx.tenantModule.create({ data: { tenantId: id, moduleKey: 'FEES' } });
      }),
    ).rejects.toThrow(/row-level security/i);
    // The first insert of an institute's module rows is the provisioning one, and passes.
    await withTenant(app, id, async (tx) => {
      await tenant(tx);
      await tx.tenantModule.createMany({
        data: [
          { tenantId: id, moduleKey: 'CORE' },
          { tenantId: id, moduleKey: 'FEES', enabled: false },
        ],
      });
    });
  });

  it('an institute reads its own plan and limits, never another one’s', async () => {
    const a = await createTenant(app);
    const b = await createTenant(app);
    await register(a.id);
    await register(b.id);
    const seen = await withTenant(app, a.id, (tx) => tx.tenantSubscription.findMany());
    expect(seen.map((s) => s.tenantId)).toEqual([a.id]);
    await expect(
      withTenant(app, a.id, (tx) =>
        tx.tenantSubscription.updateMany({ data: { studentLimit: 1 } }),
      ),
    ).rejects.toThrow(DENIED);
  });

  it('every new function refuses without a platform session', async () => {
    const id = randomUUID();
    const calls = [
      `SELECT platform_institute_options()`,
      `SELECT * FROM platform_list_institutes(NULL, NULL, NULL, NULL, NULL, NULL, 0, 10)`,
      `SELECT platform_get_institute('${id}')`,
      `SELECT platform_register_institute('${id}', NULL, 'FLAT', 0, 0, 0, 0, 0, 'MONTHLY', 0, 10, NULL, NULL, NULL, NULL, NULL)`,
      `SELECT platform_set_institute_status('${id}', 'SUSPEND', 'a reason', NULL)`,
      `SELECT platform_set_module('${id}', 'FEES', true, NULL)`,
      `SELECT platform_set_limits('${id}', NULL, NULL, NULL)`,
    ];
    for (const sql of calls) {
      await expect(platform.$queryRawUnsafe(sql)).rejects.toThrow(/platform session required/);
    }
  });

  it('the platform functions’ owner can read counting columns only, never names or contents', async () => {
    const [row] = await owner.$queryRaw<{ allowed: string[]; denied: string[] }[]>`
      WITH c(tbl, col) AS (VALUES
        ('students', 'status'), ('students', 'deleted_at'), ('sms_logs', 'segments'),
        ('staff_profiles', 'name'), ('staff_profiles', 'phone'),
        ('students', 'name_bn'), ('students', 'name_en'), ('students', 'father_name_bn'),
        ('students', 'birth_registration_no'), ('students', 'present_address'),
        ('sms_logs', 'phone'), ('sms_logs', 'body'), ('student_imports', 'rows'),
        ('student_imports', 'results'), ('student_imports', 'file_name'),
        ('audit_logs', 'old_values'), ('audit_logs', 'new_values'), ('memberships', 'id'))
      SELECT
        ARRAY(SELECT tbl || '.' || col FROM c
              WHERE has_column_privilege('jantrik_platform', tbl, col, 'SELECT')) AS allowed,
        ARRAY(SELECT t FROM unnest(ARRAY['guardians', 'student_guardians', 'enrolments',
                                         'attendance_records', 'users', 'sessions'])
                        AS t
              WHERE has_any_column_privilege('jantrik_platform', t, 'SELECT')) AS denied`;
    expect(row!.allowed.sort()).toEqual([
      'sms_logs.segments',
      'staff_profiles.name',
      'staff_profiles.phone',
      'students.deleted_at',
      'students.status',
    ]);
    expect(row!.denied).toEqual([]);
  });

  it('lists with search (wildcards are literal), filters, the owner and counts', async () => {
    const token = randomUUID().slice(0, 8);
    const plain = await createTenant(app, { name: `AxB ${token}` });
    const odd = await createTenant(app, { name: `A_B 100% ${token}`, status: 'TRIAL' });
    await withTenant(app, odd.id, async (tx) => {
      const user = await tx.$queryRaw<{ id: string }[]>`
        SELECT app_find_or_create_user(${randomPhone()}, 'Owner Person', NULL)::text AS id`;
      await tx.membership.create({
        data: { tenantId: odd.id, userId: user[0]!.id, role: 'OWNER', status: 'INVITED' },
      });
      await tx.staffProfile.create({
        data: { tenantId: odd.id, userId: user[0]!.id, name: 'Owner Person', phone: randomPhone() },
      });
    });
    const { student } = await createStudent(app, odd.id, 'S-1');
    await createStudent(app, odd.id, 'S-2');
    await withTenant(app, odd.id, async (tx) => {
      await tx.student.update({ where: { id: student.id }, data: { deletedAt: new Date() } });
      await tx.smsLog.create({
        data: {
          tenantId: odd.id,
          phone: randomPhone(),
          purpose: 'ATTENDANCE_ABSENT',
          status: 'SENT',
          segments: 1,
          body: 'x',
          localDate: new Date(),
        },
      });
    });
    await register(odd.id, { trialEndsOn: '2020-01-01' });

    const all = await list({ search: token });
    expect(all.map((r) => r.id).sort()).toEqual([plain.id, odd.id].sort());
    expect(Number(all[0]!.total)).toBe(2);
    expect((await list({ search: `A_B` })).map((r) => r.id)).not.toContain(plain.id);
    expect((await list({ search: `100% ${token}` })).map((r) => r.id)).toEqual([odd.id]);

    const [row] = await list({ search: token, status: 'TRIAL' });
    expect(row).toMatchObject({
      id: odd.id,
      owner_name: 'Owner Person',
      owner_status: 'INVITED',
      active_students: 1n,
      sms_this_month: 1n,
    });
    expect((await list({ search: token, trialEnded: true })).map((r) => r.id)).toEqual([odd.id]);
    expect(await list({ search: token, type: 'NO_SUCH_TYPE' })).toEqual([]);
  });

  it('detail: metadata, modules, plan, owners and counts; never a student name', async () => {
    const t = await createTenant(app, { modules: ['ATTENDANCE'] });
    await createStudent(app, t.id, 'S-NAME');
    await register(t.id);
    const d = await detail(t.id);
    expect(d).toMatchObject({
      id: t.id,
      status: 'TRIAL',
      subscription: { planName: 'Standard', pricing: 'PER_STUDENT', corePaisa: 1000 },
      counts: { activeStudents: 1, smsThisMonth: 0 },
    });
    expect(d['modules']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'CORE', enabled: true }),
        expect.objectContaining({ key: 'ATTENDANCE', enabled: true }),
      ]),
    );
    expect(JSON.stringify(d)).not.toContain('Student S-NAME');
    await expect(detail(randomUUID())).rejects.toThrow(/PLATFORM_NOT_FOUND/);
  });

  it('registers once, with a platform audit entry', async () => {
    const t = await createTenant(app);
    await register(t.id);
    await expect(register(t.id)).rejects.toThrow(/PLATFORM_ALREADY_REGISTERED/);
    const logs = await owner.platformAuditLog.findMany({ where: { targetTenantId: t.id } });
    expect(logs.map((l) => [l.action, l.adminId])).toEqual([['INSTITUTE_CREATE', session.adminId]]);
  });

  it('suspend and reactivate return to the earlier status, audited on both sides', async () => {
    const t = await createTenant(app, { status: 'TRIAL' });
    await expect(setStatus(t.id, 'SUSPEND', 'no')).rejects.toThrow(/PLATFORM_REASON_REQUIRED/);
    expect(await setStatus(t.id, 'SUSPEND', 'unpaid invoice')).toBe('SUSPENDED');
    await expect(setStatus(t.id, 'SUSPEND')).rejects.toThrow(/PLATFORM_BAD_STATUS/);
    expect(await detail(t.id)).toMatchObject({ status: 'SUSPENDED', suspendedFrom: 'TRIAL' });
    expect(await setStatus(t.id, 'REACTIVATE', 'paid')).toBe('TRIAL');
    expect(await detail(t.id)).toMatchObject({ status: 'TRIAL', suspendedFrom: null });
    await expect(setStatus(t.id, 'REACTIVATE')).rejects.toThrow(/PLATFORM_BAD_STATUS/);

    const platformLogs = await owner.platformAuditLog.findMany({
      where: { targetTenantId: t.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(platformLogs.map((l) => l.action)).toEqual([
      'INSTITUTE_SUSPEND',
      'INSTITUTE_REACTIVATE',
    ]);
    const own = await withTenant(app, t.id, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'tenant' }, orderBy: { createdAt: 'asc' } }),
    );
    expect(own.map((l) => [l.actorUserId, l.newValues])).toEqual([
      [
        null,
        expect.objectContaining({
          status: 'SUSPENDED',
          via: 'platform',
          reason: 'unpaid invoice',
          platformAdminId: session.adminId,
        }),
      ],
      [null, expect.objectContaining({ status: 'TRIAL', via: 'platform' })],
    ]);
  });

  it('modules: CORE stays on; a change is audited, a repeat is a no-op', async () => {
    const t = await createTenant(app);
    const setModule = (module: string, enabled: boolean) =>
      asPlatform(async (tx) => {
        const [row] = await tx.$queryRaw<{ changed: boolean }[]>`
          SELECT platform_set_module(${t.id}::uuid, ${module}, ${enabled}, NULL) AS changed`;
        return row!.changed;
      });
    await expect(setModule('CORE', false)).rejects.toThrow(/PLATFORM_CORE_REQUIRED/);
    await expect(setModule('NOPE', true)).rejects.toThrow(/PLATFORM_BAD_MODULE/);
    expect(await setModule('FEES', true)).toBe(true);
    expect(await setModule('FEES', true)).toBe(false);
    expect(await setModule('FEES', false)).toBe(true);
    const modules = await withTenant(app, t.id, (tx) =>
      tx.tenantModule.findMany({ where: { moduleKey: 'FEES' } }),
    );
    expect(modules).toEqual([expect.objectContaining({ enabled: false, enabledAt: null })]);
    const logs = await owner.platformAuditLog.findMany({
      where: { targetTenantId: t.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs.map((l) => l.action)).toEqual(['INSTITUTE_MODULE_ON', 'INSTITUTE_MODULE_OFF']);
  });

  it('limits: set on an institute without a plan, read by the institute', async () => {
    const t = await createTenant(app);
    await asPlatform(
      (tx) => tx.$executeRaw`SELECT platform_set_limits(${t.id}::uuid, 50, 20, NULL)`,
    );
    const [sub] = await withTenant(app, t.id, (tx) => tx.tenantSubscription.findMany());
    expect(sub).toMatchObject({ planName: null, studentLimit: 50, smsDailyCap: 20 });
    await expect(
      asPlatform((tx) => tx.$executeRaw`SELECT platform_set_limits(${t.id}::uuid, 0, NULL, NULL)`),
    ).rejects.toThrow(/tenant_subscriptions_student_limit/);
  });
});

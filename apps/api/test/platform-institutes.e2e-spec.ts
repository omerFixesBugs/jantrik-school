import { randomUUID } from 'node:crypto';
import { findOrCreateUser, withTenant } from '@jantrik/db';
import {
  toCsv,
  type AttendanceSettings,
  type AuthResponse,
  type ImportPreviewPage,
  type PlatformInstituteDetail,
  type PlatformInstituteOptions,
  type PlatformInstitutePage,
  type StudentImportSummary,
} from '@jantrik/shared';
import {
  addMember,
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  randomPhone,
  type Harness,
} from './support/harness.js';
import { ownerClient, platform, platformAdminCookie } from './support/platform.js';
import { school } from './support/school.js';

// Step 8, part 2: institutes from the platform side. Creating one (template, owner invitation,
// plan), the owner's first login, suspension, modules, limits, and that the platform never sees
// an institute's students, guardians or attendance. See docs/platform.md.

describe('platform: institutes', () => {
  let h: Harness;
  let cookie: string;

  const p = () => platform(h, cookie);
  const body = (over: Record<string, unknown> = {}) => ({
    name: 'নতুন বিদ্যালয়',
    slug: `s-${randomUUID().slice(0, 8)}`,
    instituteTypeKey: 'NCTB_SCHOOL_BN',
    modules: ['ATTENDANCE'],
    owner: { phone: randomPhone(), name: 'Owner Typed', nameBn: 'মালিক' },
    plan: { planName: 'Standard', pricing: 'PER_STUDENT', corePaisa: 1000, attendancePaisa: 500 },
    trialEndsOn: '2026-12-31',
    ...over,
  });
  const create = async (over: Record<string, unknown> = {}) => {
    const b = body(over);
    const res = await p().post('/platform/institutes').send(b).expect(201);
    return { b, res: res.body as { id: string; owner: Record<string, unknown> }, text: res.text };
  };
  const detail = async (id: string) =>
    (await p().get(`/platform/institutes/${id}`).expect(200)).body as PlatformInstituteDetail;
  /** The owner signs in by OTP, accepts, and gets a token for the institute. */
  const ownerJoins = async (phone: string, tenantId: string): Promise<string> => {
    const login = await otpLogin(h, phone);
    await http(h)
      .post(`/me/invitations/${tenantId}/accept`)
      .set(bearer(login.accessToken))
      .send({ roles: ['OWNER'] })
      .expect(204);
    const switched = await http(h)
      .post('/auth/switch-tenant')
      .set(bearer(login.accessToken))
      .send({ tenantId })
      .expect(200);
    return (switched.body as AuthResponse).accessToken;
  };
  const platformLogs = async (tenantId: string) => {
    const owner = ownerClient();
    try {
      return await owner.platformAuditLog.findMany({
        where: { targetTenantId: tenantId },
        orderBy: { createdAt: 'asc' },
      });
    } finally {
      await owner.$disconnect();
    }
  };

  beforeAll(async () => {
    h = await createHarness();
    cookie = await platformAdminCookie(h);
  });

  afterAll(async () => {
    await h.close();
  });

  it('only a platform session: an institute token or no cookie gets 401', async () => {
    const t = await createTenant(h);
    const admin = await otpLogin(h, (await addMember(h, t.id, { roles: ['OWNER'] })).phone);
    await platform(h).get('/platform/institutes').set(bearer(admin.accessToken)).expect(401);
    await platform(h).get('/platform/institutes').expect(401);
    await platform(h).post('/platform/institutes').send(body()).expect(401);
  });

  it('creates a TRIAL institute from the template with an OWNER invitation; audited on both sides', async () => {
    const { b, res } = await create();
    expect(res).toMatchObject({
      name: b.name,
      slug: b.slug,
      owner: { name: 'Owner Typed', nameBn: 'মালিক', phone: b.owner.phone, status: 'INVITED' },
    });
    const inside = await withTenant(h.prisma, res.id, async (tx) => ({
      tenant: await tx.tenant.findFirstOrThrow(),
      classLevels: await tx.classLevel.count(),
      year: await tx.academicYear.findFirst({ where: { isCurrent: true } }),
      memberships: await tx.membership.findMany(),
      profiles: await tx.staffProfile.findMany(),
      modules: await tx.tenantModule.findMany({ where: { enabled: true } }),
      plan: await tx.tenantSubscription.findFirst(),
      audit: await tx.auditLog.findMany({ where: { entity: 'tenant' } }),
    }));
    expect(inside.tenant.status).toBe('TRIAL');
    expect(inside.classLevels).toBeGreaterThan(5);
    expect(inside.year?.name).toBe(new Date().getFullYear().toString());
    expect(inside.memberships).toEqual([
      expect.objectContaining({ role: 'OWNER', status: 'INVITED' }),
    ]);
    expect(inside.profiles).toEqual([
      expect.objectContaining({ name: 'Owner Typed', nameBn: 'মালিক', phone: b.owner.phone }),
    ]);
    expect(inside.modules.map((m) => m.moduleKey).sort()).toEqual(['ATTENDANCE', 'CORE']);
    expect(inside.plan).toMatchObject({
      planName: 'Standard',
      pricing: 'PER_STUDENT',
      corePaisa: 1000,
      attendancePaisa: 500,
      studentLimit: null,
    });
    expect(inside.audit).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        actorUserId: null,
        newValues: expect.objectContaining({ via: 'platform', slug: b.slug }),
      }),
    ]);
    expect((await platformLogs(res.id)).map((l) => l.action)).toEqual(['INSTITUTE_CREATE']);

    const d = await detail(res.id);
    expect(d).toMatchObject({
      status: 'TRIAL',
      trialEnded: false,
      subscription: { planName: 'Standard', trialEndsOn: '2026-12-31' },
      owners: [{ name: 'Owner Typed', phone: b.owner.phone, status: 'INVITED' }],
      counts: { activeStudents: 0, activeStaff: 0 },
    });
    expect(d.owners[0]!.inviteExpiresAt).not.toBeNull();
  });

  it('an existing phone gets the same response; its global name is neither shown nor changed', async () => {
    const elsewhere = await createTenant(h);
    const phone = randomPhone();
    const userId = await withTenant(h.prisma, elsewhere.id, (tx) =>
      findOrCreateUser(tx, phone, 'Secret Global Name'),
    );
    const known = await create({ owner: { phone, name: 'Owner Typed', nameBn: 'মালিক' } });
    const fresh = await create();
    expect(Object.keys(known.res).sort()).toEqual(Object.keys(fresh.res).sort());
    expect(Object.keys(known.res.owner).sort()).toEqual(Object.keys(fresh.res.owner).sort());
    expect(known.res.owner).toMatchObject({ name: 'Owner Typed', phone });
    expect(known.text).not.toContain('Secret Global Name');
    expect(JSON.stringify(await detail(known.res.id))).not.toContain('Secret Global Name');
    const global = await h.prisma.$queryRaw<{ name: string }[]>`
      SELECT name FROM auth_find_user_for_login(${phone}, NULL)`;
    expect(global[0]?.name).toBe('Secret Global Name');
    expect(userId).toBeTruthy();
  });

  it('slug: taken is 409, reserved or malformed is 400; an unknown type is 422', async () => {
    const { b } = await create();
    const clash = await p()
      .post('/platform/institutes')
      .send(body({ slug: b.slug }))
      .expect(409);
    expect(clash.body).toMatchObject({ code: 'SLUG_TAKEN', field: 'slug' });
    await p()
      .post('/platform/institutes')
      .send(body({ slug: 'platform' }))
      .expect(400);
    await p()
      .post('/platform/institutes')
      .send(body({ slug: 'Bad Slug!' }))
      .expect(400);
    const type = await p()
      .post('/platform/institutes')
      .send(body({ instituteTypeKey: 'NO_SUCH_TYPE' }))
      .expect(422);
    expect(type.body).toMatchObject({ code: 'UNKNOWN_INSTITUTE_TYPE' });
  });

  it('the owner signs in, accepts and runs it; suspension blocks the next request, reactivation restores it', async () => {
    const { b, res } = await create();
    const token = await ownerJoins(b.owner.phone, res.id);
    await http(h).get('/students').set(bearer(token)).expect(200);
    expect((await detail(res.id)).owners[0]).toMatchObject({ status: 'ACTIVE' });

    await p().post(`/platform/institutes/${res.id}/suspend`).send({}).expect(400);
    const suspended = (
      await p()
        .post(`/platform/institutes/${res.id}/suspend`)
        .send({ reason: 'invoice unpaid' })
        .expect(200)
    ).body as PlatformInstituteDetail;
    expect(suspended).toMatchObject({ status: 'SUSPENDED', suspendedFrom: 'TRIAL' });
    await http(h).get('/students').set(bearer(token)).expect(403);
    const again = await p()
      .post(`/platform/institutes/${res.id}/suspend`)
      .send({ reason: 'twice' })
      .expect(409);
    expect(again.body).toMatchObject({ code: 'BAD_STATUS' });

    const back = (
      await p()
        .post(`/platform/institutes/${res.id}/reactivate`)
        .send({ reason: 'paid in cash' })
        .expect(200)
    ).body as PlatformInstituteDetail;
    expect(back).toMatchObject({ status: 'TRIAL', suspendedFrom: null });
    await http(h).get('/students').set(bearer(token)).expect(200);
    expect((await platformLogs(res.id)).map((l) => l.action)).toEqual([
      'INSTITUTE_CREATE',
      'INSTITUTE_SUSPEND',
      'INSTITUTE_REACTIVATE',
    ]);
  });

  it('modules switch on and off at once; CORE cannot be switched', async () => {
    const { res } = await create({ modules: [] });
    const admin = (await otpLogin(h, (await addMember(h, res.id, { roles: ['ADMIN'] })).phone))
      .accessToken;
    const settings = () => http(h).get('/attendance/settings').set(bearer(admin));
    await settings().expect(403); // cached as off
    await p()
      .put(`/platform/institutes/${res.id}/modules/ATTENDANCE`)
      .send({ enabled: true })
      .expect(200);
    await settings().expect(200);
    const off = (
      await p()
        .put(`/platform/institutes/${res.id}/modules/ATTENDANCE`)
        .send({ enabled: false })
        .expect(200)
    ).body as PlatformInstituteDetail;
    expect(off.modules.find((m) => m.key === 'ATTENDANCE')).toMatchObject({ enabled: false });
    await settings().expect(403);
    await p()
      .put(`/platform/institutes/${res.id}/modules/CORE`)
      .send({ enabled: false })
      .expect(400);
  });

  it('limits: the student limit stops admissions and import rows; the SMS ceiling lowers the cap', async () => {
    const t = await createTenant(h, { modules: ['ATTENDANCE'] });
    const admin = (await otpLogin(h, (await addMember(h, t.id, { roles: ['ADMIN'] })).phone))
      .accessToken;
    const ids = await withTenant(h.prisma, t.id, async (tx) => {
      const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      const c6 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_6' } });
      await tx.section.create({
        data: { tenantId: t.id, academicYearId: year.id, classLevelId: c6.id, name: 'ক' },
      });
      return { year: year.id, c6: c6.id };
    });
    const limits = (studentLimit: number | null, smsDailyCap: number | null) =>
      p()
        .put(`/platform/institutes/${t.id}/limits`)
        .send({ studentLimit, smsDailyCap })
        .expect(200);
    const admit = (name: string) =>
      http(h)
        .post('/students')
        .set(bearer(admin))
        .send({
          nameEn: name,
          guardians: [
            { phone: randomPhone(), nameEn: `${name} Parent`, relation: 'FATHER', isPrimary: true },
          ],
          enrolment: {
            academicYearId: ids.year,
            classLevelId: ids.c6,
            sectionId: null,
            roll: null,
          },
        });

    await limits(1, 1);
    await admit('First').expect(201);
    const refused = await admit('Second').expect(422);
    expect(refused.body).toMatchObject({ code: 'STUDENT_LIMIT', limit: 1 });

    // An import row over the limit is reported on the row; the import still finishes.
    const csv = toCsv([
      ['Name', 'Class', 'Mobile', 'Guardian name'],
      ['Third', 'Class 6', randomPhone().slice(3), 'Third Parent'],
    ]);
    const up = (
      await http(h)
        .post('/student-imports')
        .set(bearer(admin))
        .attach('file', Buffer.from(csv), 'students.csv')
        .expect(201)
    ).body as StudentImportSummary;
    await http(h).post(`/student-imports/${up.id}/run`).set(bearer(admin)).expect(202);
    await vi.waitFor(
      async () => {
        const s = (await http(h).get(`/student-imports/${up.id}`).set(bearer(admin)).expect(200))
          .body as StudentImportSummary;
        if (s.status !== 'DONE') throw new Error(s.status);
      },
      { timeout: 20_000, interval: 200 },
    );
    const rows = (
      await http(h)
        .get(`/student-imports/${up.id}/rows?filter=error`)
        .set(bearer(admin))
        .expect(200)
    ).body as ImportPreviewPage;
    expect(rows.rows.map((r) => r.errors.map((e) => e.code))).toEqual([['STUDENT_LIMIT']]);

    // 1 active student: automatic cap 2, the platform ceiling 1 wins.
    const s = (await http(h).get('/attendance/settings').set(bearer(admin)).expect(200))
      .body as AttendanceSettings;
    expect(s).toMatchObject({ automaticSmsCap: 2, platformSmsCap: 1, effectiveDailySmsCap: 1 });

    await limits(null, null);
    await admit('Second').expect(201);
    const after = (await http(h).get('/attendance/settings').set(bearer(admin)).expect(200))
      .body as AttendanceSettings;
    expect(after).toMatchObject({ platformSmsCap: null, effectiveDailySmsCap: 4 });
  });

  it('lists with search, filters, owner and counts; options list types and plans', async () => {
    const token = randomUUID().slice(0, 8);
    const one = await create({ name: `Alpha ${token}` });
    const two = await create({
      name: `Beta ${token}`,
      plan: { planName: `Gold ${token}`, pricing: 'FLAT', flatPaisa: 500000 },
    });
    const page = (q: string) =>
      p()
        .get(`/platform/institutes?${q}`)
        .expect(200)
        .then((r) => r.body as PlatformInstitutePage);

    const all = await page(`search=${token}`);
    expect(all.total).toBe(2);
    expect(all.items.map((i) => i.id).sort()).toEqual([one.res.id, two.res.id].sort());
    expect(all.items.find((i) => i.id === one.res.id)).toMatchObject({
      status: 'TRIAL',
      planName: 'Standard',
      owner: { name: 'Owner Typed', status: 'INVITED' },
      activeStudents: 0,
      smsThisMonth: 0,
      type: { key: 'NCTB_SCHOOL_BN' },
    });
    expect((await page(`search=${token}&plan=Gold%20${token}`)).items.map((i) => i.id)).toEqual([
      two.res.id,
    ]);
    expect((await page(`search=${token}&status=SUSPENDED`)).total).toBe(0);
    expect(await page(`search=${token}&page=5`)).toMatchObject({ items: [], total: 2 });
    await p().get('/platform/institutes?status=NOPE').expect(400);

    const options = (await p().get('/platform/institutes/options').expect(200))
      .body as PlatformInstituteOptions;
    expect(options.types.map((t) => t.key)).toContain('NCTB_SCHOOL_BN');
    expect(options.plans).toContain(`Gold ${token}`);
  });

  it('owner invitation: cancel, invite another, resend only once expired or declined', async () => {
    const { b, res } = await create();
    const first = (await detail(res.id)).owners[0]!;
    const path = `/platform/institutes/${res.id}/owner-invitations`;

    await p().post(`${path}/${first.userId}/resend`).expect(409); // still pending
    await p().post(path).send({ phone: randomPhone(), name: 'Another' }).expect(409); // pending
    const backdate = (userId: string) =>
      withTenant(h.prisma, res.id, (tx) =>
        tx.membership.updateMany({
          where: { userId },
          data: { invitedAt: new Date(Date.now() - 15 * 86_400_000) },
        }),
      );

    // 15 days later the first invitation has expired: someone else may be invited, and then the
    // expired one cannot be sent again (one pending owner invitation at a time).
    await backdate(first.userId);
    expect((await detail(res.id)).owners[0]).toMatchObject({ status: 'EXPIRED' });
    const phone = randomPhone();
    const invited = (await p().post(path).send({ phone, name: 'Right Number' }).expect(200))
      .body as PlatformInstituteDetail;
    const second = invited.owners.find((o) => o.phone === phone)!;
    expect(second).toMatchObject({ name: 'Right Number', status: 'INVITED' });
    const busy = await p().post(`${path}/${first.userId}/resend`).expect(409);
    expect(busy.body).toMatchObject({ code: 'OWNER_INVITED' });
    // The wrong number's invitation is withdrawn.
    const withdrawn = (await p().post(`${path}/${first.userId}/cancel`).expect(200))
      .body as PlatformInstituteDetail;
    expect(withdrawn.owners.map((o) => o.userId)).toEqual([second.userId]);

    // The second one expires too and is sent again.
    await backdate(second.userId);
    expect((await detail(res.id)).owners[0]).toMatchObject({ status: 'EXPIRED' });
    await p().post(`${path}/${second.userId}/resend`).expect(200);
    expect((await detail(res.id)).owners[0]).toMatchObject({ status: 'INVITED' });

    // Once accepted, the institute manages its owners itself.
    await ownerJoins(phone, res.id);
    const cancel = await p().post(`${path}/${second.userId}/cancel`).expect(409);
    expect(cancel.body).toMatchObject({ code: 'INSTITUTE_HAS_OWNER' });
    const has = await p().post(path).send({ phone: randomPhone(), name: 'Third' }).expect(409);
    expect(has.body).toMatchObject({ code: 'INSTITUTE_HAS_OWNER' });
    expect(b.owner.phone).not.toBe(phone);
    expect((await platformLogs(res.id)).map((l) => l.action)).toEqual([
      'INSTITUTE_CREATE',
      'INSTITUTE_OWNER_INVITE',
      'INSTITUTE_OWNER_CANCEL',
      'INSTITUTE_OWNER_REINVITE',
    ]);
    const own = await withTenant(h.prisma, res.id, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'membership' }, orderBy: { createdAt: 'asc' } }),
    );
    // The platform's changes have no institute actor; the owner's own accept names them.
    const viaPlatform = own.filter(
      (l) => (l.newValues as { via?: string } | null)?.via === 'platform',
    );
    expect(viaPlatform).toHaveLength(3); // invite, cancel, reinvite
    expect(viaPlatform.every((l) => l.actorUserId === null)).toBe(true);
    expect(
      own.find((l) => (l.newValues as { by?: string } | null)?.by === 'invitee'),
    ).toMatchObject({ actorUserId: second.userId });
  });

  it('never returns an institute’s students, guardians or attendance', async () => {
    const s = await school(h);
    await withTenant(h.prisma, s.tenantId, async (tx) => {
      await tx.student.update({
        where: { id: s.a[0]!.id },
        data: { nameEn: 'Zubair Secretname', nameBn: 'গোপননাম ছাত্র' },
      });
      await tx.guardian.updateMany({ data: { nameEn: 'Guardian Secretname' } });
    });
    const texts = [
      (await p().get(`/platform/institutes/${s.tenantId}`).expect(200)).text,
      (await p().get('/platform/institutes?pageSize=100').expect(200)).text,
      (await p().get('/platform/institutes/options').expect(200)).text,
      (await p().get('/platform/audit').expect(200)).text,
    ];
    const detailBody = JSON.parse(texts[0]!) as PlatformInstituteDetail;
    expect(detailBody.counts.activeStudents).toBe(s.a.length + s.b.length);
    for (const text of texts) {
      expect(text).not.toContain('Secretname');
      expect(text).not.toContain('গোপননাম');
      for (const g of [...s.a, ...s.b]) expect(text).not.toContain(g.phone);
    }
  });
});

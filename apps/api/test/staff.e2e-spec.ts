import { withContext, withTenant } from '@jantrik/db';
import type { SetupSection, StaffMember } from '@jantrik/shared';
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

describe('staff management', () => {
  let h: Harness;
  let tenantId: string;
  let owner: { userId: string; token: string };
  let admin: { userId: string; token: string };
  let teacher: { userId: string; token: string };

  const login = async (t: string, roles: ('OWNER' | 'ADMIN' | 'TEACHER' | 'GUARDIAN')[]) => {
    const m = await addMember(h, t, { roles });
    return { userId: m.userId, token: (await otpLogin(h, m.phone)).accessToken };
  };
  const list = async (token = admin.token) =>
    (await http(h).get('/staff').set(bearer(token)).expect(200)).body as StaffMember[];
  const find = async (userId: string) => (await list(owner.token)).find((m) => m.userId === userId);

  beforeAll(async () => {
    h = await createHarness();
    tenantId = (await createTenant(h)).id;
    owner = await login(tenantId, ['OWNER']);
    admin = await login(tenantId, ['ADMIN']);
    teacher = await login(tenantId, ['TEACHER']);
  });

  afterAll(async () => {
    await h.close();
  });

  it('is for OWNER/ADMIN only and lists staff with their roles', async () => {
    await http(h).get('/staff').set(bearer(teacher.token)).expect(403);
    const staff = await list();
    expect(staff.map((s) => s.userId)).toEqual(
      expect.arrayContaining([owner.userId, admin.userId, teacher.userId]),
    );
    expect(staff.find((s) => s.userId === admin.userId)).toMatchObject({
      roles: ['ADMIN'],
      status: 'ACTIVE',
      isSelf: true,
    });
  });

  it('invites staff by phone (Bangla digits) with a Bangla name; access after they accept', async () => {
    const local = randomPhone().slice(3); // 01XXXXXXXXX
    const bangla = local.replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!);
    const member = (
      await http(h)
        .post('/staff')
        .set(bearer(admin.token))
        .send({ phone: bangla, name: 'Karim Uddin', nameBn: 'করিম উদ্দিন', roles: ['TEACHER'] })
        .expect(201)
    ).body as StaffMember;
    expect(member).toMatchObject({
      phone: `+88${local}`,
      nameBn: 'করিম উদ্দিন',
      roles: ['TEACHER'],
      status: 'INVITED',
    });
    expect(h.sms.sentTo(`+88${local}`)).toEqual([]); // no invite SMS
    const login = await otpLogin(h, `+88${local}`);
    await http(h)
      .post(`/me/invitations/${tenantId}/accept`)
      .set(bearer(login.accessToken))
      .send({ roles: ['TEACHER'] })
      .expect(204);
    const switched = await http(h)
      .post('/auth/switch-tenant')
      .set(bearer(login.accessToken))
      .send({ tenantId })
      .expect(200);
    const ctx = (
      await http(h)
        .get('/me/context')
        .set(bearer(switched.body.accessToken as string))
        .expect(200)
    ).body as { roles: string[] };
    expect(ctx.roles).toEqual(['TEACHER']);

    // Again: 409.
    const again = await http(h)
      .post('/staff')
      .set(bearer(admin.token))
      .send({ phone: local, name: 'x', roles: ['ADMIN'] })
      .expect(409);
    expect(again.body.code).toBe('ALREADY_STAFF');
  });

  it('a guardian here can be invited as staff; the guardian membership stays; the typed name is used', async () => {
    const guardian = await addMember(h, tenantId, { roles: ['GUARDIAN'], name: 'Guardian Name' });
    const m = (
      await http(h)
        .post('/staff')
        .set(bearer(admin.token))
        .send({ phone: guardian.phone, name: 'Renamed', nameBn: 'নতুন নাম', roles: ['STAFF'] })
        .expect(201)
    ).body as StaffMember;
    // The institute's own (typed) name, never the person's global one.
    expect(m).toMatchObject({ userId: guardian.userId, name: 'Renamed', nameBn: 'নতুন নাম' });
    const roles = await withTenant(h.prisma, tenantId, (tx) =>
      tx.membership.findMany({ where: { userId: guardian.userId }, select: { role: true } }),
    );
    expect(roles.map((r) => r.role).sort()).toEqual(['GUARDIAN', 'STAFF']);
  });

  it('role changes take effect at once (roles cache invalidated)', async () => {
    await http(h).get('/setup/class-levels').set(bearer(teacher.token)).expect(403);
    await http(h)
      .put(`/staff/${teacher.userId}/roles`)
      .set(bearer(admin.token))
      .send({ roles: ['TEACHER', 'ADMIN'] })
      .expect(200);
    await http(h).get('/setup/class-levels').set(bearer(teacher.token)).expect(200);
    await http(h)
      .put(`/staff/${teacher.userId}/roles`)
      .set(bearer(admin.token))
      .send({ roles: ['TEACHER'] })
      .expect(200);
    await http(h).get('/setup/class-levels').set(bearer(teacher.token)).expect(403);
  });

  it('only an owner can grant OWNER or touch an owner; nobody changes themselves', async () => {
    const extra = await addMember(h, tenantId, { roles: ['TEACHER'] });
    await http(h)
      .put(`/staff/${extra.userId}/roles`)
      .set(bearer(admin.token))
      .send({ roles: ['OWNER'] })
      .expect(403);
    await http(h)
      .post('/staff')
      .set(bearer(admin.token))
      .send({ phone: randomPhone(), name: 'x', roles: ['OWNER'] })
      .expect(403);
    await http(h).post(`/staff/${owner.userId}/deactivate`).set(bearer(admin.token)).expect(403);
    await http(h)
      .put(`/staff/${owner.userId}/roles`)
      .set(bearer(admin.token))
      .send({ roles: ['OWNER', 'TEACHER'] })
      .expect(403);
    const self = await http(h)
      .put(`/staff/${admin.userId}/roles`)
      .set(bearer(admin.token))
      .send({ roles: ['OWNER'] })
      .expect(403);
    expect(self.body.code).toBe('SELF_CHANGE');
    await http(h).post(`/staff/${owner.userId}/deactivate`).set(bearer(owner.token)).expect(403);
    // The owner can make someone an owner.
    await http(h)
      .put(`/staff/${extra.userId}/roles`)
      .set(bearer(owner.token))
      .send({ roles: ['OWNER'] })
      .expect(200);
    expect((await find(extra.userId))!.roles).toEqual(['OWNER']);
  });

  it('two owners demoting each other at once: one wins, the last owner stays', async () => {
    const t = (await createTenant(h)).id;
    const a = await login(t, ['OWNER']);
    const b = await login(t, ['OWNER']);
    const [ra, rb] = await Promise.all([
      http(h)
        .put(`/staff/${b.userId}/roles`)
        .set(bearer(a.token))
        .send({ roles: ['TEACHER'] }),
      http(h)
        .put(`/staff/${a.userId}/roles`)
        .set(bearer(b.token))
        .send({ roles: ['TEACHER'] }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 403]);
    const owners = await withTenant(h.prisma, t, (tx) =>
      tx.membership.count({ where: { role: 'OWNER', status: 'ACTIVE' } }),
    );
    expect(owners).toBe(1);
  });

  it('deactivating ends access on the next request; activating restores it', async () => {
    const t = await login(tenantId, ['TEACHER']);
    await http(h).get('/me/context').set(bearer(t.token)).expect(200);
    const off = (
      await http(h).post(`/staff/${t.userId}/deactivate`).set(bearer(admin.token)).expect(200)
    ).body as StaffMember;
    expect(off.status).toBe('DISABLED');
    await http(h).get('/me/context').set(bearer(t.token)).expect(403);
    await http(h).post(`/staff/${t.userId}/activate`).set(bearer(admin.token)).expect(200);
    await http(h).get('/me/context').set(bearer(t.token)).expect(200);
  });

  it('assigns current-year sections to teachers only, within this institute', async () => {
    const year = await withTenant(h.prisma, tenantId, (tx) =>
      tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } }),
    );
    const classLevel = await withTenant(h.prisma, tenantId, (tx) =>
      tx.classLevel.findFirstOrThrow({ orderBy: { sortOrder: 'asc' } }),
    );
    const section = (
      await http(h)
        .post('/setup/sections')
        .set(bearer(admin.token))
        .send({ academicYearId: year.id, classLevelId: classLevel.id, name: 'ক' })
        .expect(201)
    ).body as SetupSection;
    const m = (
      await http(h)
        .put(`/staff/${teacher.userId}/sections`)
        .set(bearer(admin.token))
        .send({ sectionIds: [section.id] })
        .expect(200)
    ).body as StaffMember;
    expect(m.sections).toMatchObject([{ id: section.id, name: 'ক', isClassTeacher: true }]);

    const accountant = await addMember(h, tenantId, { roles: ['ACCOUNTANT'] });
    await http(h)
      .put(`/staff/${accountant.userId}/sections`)
      .set(bearer(admin.token))
      .send({ sectionIds: [section.id] })
      .expect(422);

    // Another institute's section or person.
    const other = (await createTenant(h)).id;
    const otherAdmin = await login(other, ['ADMIN']);
    const otherSection = await withTenant(h.prisma, other, async (tx) => {
      const y = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      const c = await tx.classLevel.findFirstOrThrow();
      return tx.section.create({
        data: { tenantId: other, academicYearId: y.id, classLevelId: c.id, name: 'X' },
      });
    });
    const r = await http(h)
      .put(`/staff/${teacher.userId}/sections`)
      .set(bearer(admin.token))
      .send({ sectionIds: [otherSection.id] })
      .expect(422);
    expect(r.body.code).toBe('INVALID_SECTIONS');
    await http(h)
      .put(`/staff/${teacher.userId}/sections`)
      .set(bearer(otherAdmin.token))
      .send({ sectionIds: [] })
      .expect(404);
    await http(h)
      .post(`/staff/${teacher.userId}/deactivate`)
      .set(bearer(otherAdmin.token))
      .expect(404);
    expect((await list(otherAdmin.token)).map((s) => s.userId)).not.toContain(teacher.userId);
  });

  it('everything is audited', async () => {
    const rows = await withContext(h.prisma, { tenantId }, (tx) =>
      tx.auditLog.findMany({ where: { entity: { in: ['membership', 'section_teachers'] } } }),
    );
    const kinds = new Set(rows.map((r) => `${r.entity}:${r.action}`));
    expect([...kinds].sort()).toEqual(
      ['membership:CREATE', 'membership:UPDATE', 'section_teachers:UPDATE'].sort(),
    );
  });
});

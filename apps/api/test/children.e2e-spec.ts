import { findOrCreateUser, withTenant, type PrismaClient } from '@jantrik/db';
import type { GuardianChild } from '@jantrik/shared';
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

/** A guardian record (with a login) in a tenant; returns the guardian id. */
async function guardian(prisma: PrismaClient, tenantId: string, phone: string): Promise<string> {
  return withTenant(prisma, tenantId, async (tx) => {
    const userId = await findOrCreateUser(tx, phone, 'Parent');
    const existing = await tx.membership.findFirst({ where: { userId, role: 'GUARDIAN' } });
    if (!existing) await tx.membership.create({ data: { tenantId, userId, role: 'GUARDIAN' } });
    const g = await tx.guardian.create({ data: { tenantId, userId, nameEn: 'Parent', phone } });
    return g.id;
  });
}

/** A student enrolled in Class 6 / section "A" (current year), linked to a guardian. */
async function child(
  prisma: PrismaClient,
  tenantId: string,
  guardianId: string,
  code: string,
  opts: { roll?: number; relation?: 'FATHER' | 'MOTHER'; deleted?: boolean } = {},
) {
  return withTenant(prisma, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const class6 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_6' } });
    const section =
      (await tx.section.findFirst({ where: { classLevelId: class6.id, name: 'A' } })) ??
      (await tx.section.create({
        data: { tenantId, academicYearId: year.id, classLevelId: class6.id, name: 'A' },
      }));
    const s = await tx.student.create({
      data: {
        tenantId,
        studentCode: code,
        nameEn: `Child ${code}`,
        nameBn: `শিশু ${code}`,
        deletedAt: opts.deleted ? new Date() : null,
      },
    });
    await tx.enrolment.create({
      data: {
        tenantId,
        studentId: s.id,
        academicYearId: year.id,
        classLevelId: class6.id,
        sectionId: section.id,
        roll: opts.roll ?? null,
      },
    });
    await tx.studentGuardian.create({
      data: { tenantId, studentId: s.id, guardianId, relation: opts.relation ?? 'FATHER' },
    });
    return s;
  });
}

describe('GET /me/children', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  const children = async (token: string) =>
    (await http(h).get('/me/children').set(bearer(token)).expect(200)).body as GuardianChild[];

  it("returns only the caller's own children, with class, section and roll", async () => {
    const t = await createTenant(h);
    const phone = randomPhone();
    const mine = await guardian(h.prisma, t.id, phone);
    const other = await guardian(h.prisma, t.id, randomPhone());
    await child(h.prisma, t.id, mine, 'C-002', { roll: 7, relation: 'MOTHER' });
    await child(h.prisma, t.id, mine, 'C-001', { roll: 3 });
    await child(h.prisma, t.id, other, 'C-003'); // same school, another family

    const list = await children((await otpLogin(h, phone)).accessToken);
    expect(list.map((c) => c.studentCode)).toEqual(['C-001', 'C-002']);
    expect(list[1]).toMatchObject({
      nameEn: 'Child C-002',
      status: 'ACTIVE',
      relation: 'MOTHER',
      enrolment: { classLevel: { nameEn: 'Class 6' }, section: { name: 'A' }, roll: 7 },
    });
  });

  it('leaves out soft-deleted students', async () => {
    const t = await createTenant(h);
    const phone = randomPhone();
    const g = await guardian(h.prisma, t.id, phone);
    await child(h.prisma, t.id, g, 'D-001');
    await child(h.prisma, t.id, g, 'D-002', { deleted: true });
    const list = await children((await otpLogin(h, phone)).accessToken);
    expect(list.map((c) => c.studentCode)).toEqual(['D-001']);
  });

  it('is scoped to the selected institute: a parent in two institutes sees one at a time', async () => {
    const a = await createTenant(h);
    const b = await createTenant(h);
    const phone = randomPhone();
    await child(h.prisma, a.id, await guardian(h.prisma, a.id, phone), 'A-001');
    await child(h.prisma, b.id, await guardian(h.prisma, b.id, phone), 'B-001');

    const login = await otpLogin(h, phone); // two institutes: none selected yet
    await http(h).get('/me/children').set(bearer(login.accessToken)).expect(403);
    const tokenFor = async (tenantId: string) =>
      (
        await http(h)
          .post('/auth/switch-tenant')
          .set(bearer(login.accessToken))
          .send({ tenantId })
          .expect(200)
      ).body.accessToken as string;
    expect((await children(await tokenFor(a.id))).map((c) => c.studentCode)).toEqual(['A-001']);
    expect((await children(await tokenFor(b.id))).map((c) => c.studentCode)).toEqual(['B-001']);
  });

  it('a guardian with no linked students gets an empty list', async () => {
    const t = await createTenant(h);
    const phone = randomPhone();
    await guardian(h.prisma, t.id, phone);
    expect(await children((await otpLogin(h, phone)).accessToken)).toEqual([]);
  });

  it('is for guardians only', async () => {
    const t = await createTenant(h);
    const { phone } = await addMember(h, t.id, { roles: ['TEACHER'] });
    const login = await otpLogin(h, phone);
    await http(h).get('/me/children').set(bearer(login.accessToken)).expect(403);
  });
});

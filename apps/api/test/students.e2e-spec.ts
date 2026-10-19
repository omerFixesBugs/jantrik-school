import { findOrCreateUser, withTenant } from '@jantrik/db';
import type { StudentFilters, StudentsPage } from '@jantrik/shared';
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

interface Fixture {
  tenantId: string;
  token: string;
  class6: string;
  class9: string;
  sectionA: string;
  sectionB: string;
}

/** A school with sections, enrolled students, a guardian, a soft-deleted and an unenrolled student. */
async function school(h: Harness, prefix: string): Promise<Fixture> {
  const tenant = await createTenant(h);
  const tenantId = tenant.id;
  const ids = await withTenant(h.prisma, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const class6 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_6' } });
    const class9 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_9' } });
    const mk = (classLevelId: string, name: string) =>
      tx.section.create({ data: { tenantId, academicYearId: year.id, classLevelId, name } });
    const sectionA = await mk(class6.id, 'A');
    const sectionB = await mk(class6.id, 'B');
    const section9 = await mk(class9.id, 'A');

    const add = async (
      code: string,
      nameEn: string,
      nameBn: string,
      classLevelId: string,
      sectionId: string,
      roll: number,
    ) => {
      const s = await tx.student.create({ data: { tenantId, studentCode: code, nameEn, nameBn } });
      await tx.enrolment.create({
        data: { tenantId, studentId: s.id, academicYearId: year.id, classLevelId, sectionId, roll },
      });
      return s;
    };
    const rahim = await add(
      `${prefix}-001`,
      'Rahim Uddin',
      'রহিম উদ্দিন',
      class6.id,
      sectionA.id,
      1,
    );
    await add(`${prefix}-002`, 'Karim Mia', 'করিম মিয়া', class6.id, sectionB.id, 1);
    await add(`${prefix}-003`, 'Fatema Akter', 'ফাতেমা আক্তার', class9.id, section9.id, 1);
    const deleted = await add(
      `${prefix}-004`,
      'Rahima Deleted',
      'রহিমা',
      class6.id,
      sectionA.id,
      2,
    );
    await tx.student.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    await tx.student.create({
      data: { tenantId, studentCode: `${prefix}-005`, nameEn: 'Not Enrolled' },
    });

    const guardian = await tx.guardian.create({
      data: { tenantId, nameEn: 'Abdul Rahim Sr', phone: '+8801755599911' },
    });
    await tx.studentGuardian.create({
      data: {
        tenantId,
        studentId: rahim.id,
        guardianId: guardian.id,
        relation: 'FATHER',
        isPrimary: true,
      },
    });
    return { class6: class6.id, class9: class9.id, sectionA: sectionA.id, sectionB: sectionB.id };
  });
  // ADMIN: these tests are about listing and search mechanics; what teachers may see is in
  // student-privacy.e2e-spec.ts.
  const { phone } = await addMember(h, tenantId, { roles: ['ADMIN'] });
  const token = (await otpLogin(h, phone)).accessToken;
  return { tenantId, token, ...ids };
}

describe('GET /students', () => {
  let h: Harness;
  let a: Fixture;
  let b: Fixture;

  beforeAll(async () => {
    h = await createHarness();
    a = await school(h, 'A');
    b = await school(h, 'B');
  });

  afterAll(async () => {
    await h.close();
  });

  const list = (f: Fixture, query: Record<string, string | number> = {}) =>
    http(h).get('/students').query(query).set(bearer(f.token));

  it('lists own tenant only, sorted by code, without soft-deleted students', async () => {
    const res = await list(a).expect(200);
    const body = res.body as StudentsPage;
    expect(body.items.map((s) => s.studentCode)).toEqual(['A-001', 'A-002', 'A-003', 'A-005']);
    expect(body.nextCursor).toBeNull();
    const rahim = body.items[0]!;
    expect(rahim).toMatchObject({
      nameEn: 'Rahim Uddin',
      enrolment: { classLevel: { id: a.class6 }, section: { id: a.sectionA, name: 'A' }, roll: 1 },
      primaryGuardian: { nameEn: 'Abdul Rahim Sr', phone: '+8801755599911' },
    });
    expect(body.items.find((s) => s.studentCode === 'A-005')?.enrolment).toBeNull();
    expect(body.total).toBe(4);
  });

  it("search never returns another tenant's students", async () => {
    const res = await list(a, { q: 'B-00' }).expect(200);
    expect((res.body as StudentsPage).items).toEqual([]);
    expect((res.body as StudentsPage).total).toBe(0);
    const own = await list(b, { q: 'B-00' }).expect(200);
    expect((own.body as StudentsPage).items).toHaveLength(4);
  });

  it.each([
    ['English name', 'rahim', ['A-001']],
    ['Bangla name', 'রহিম', ['A-001']],
    ['student code', 'a-002', ['A-002']],
    ['guardian phone (local format)', '01755599911', ['A-001']],
    ['guardian phone with Bangla digits', '০১৭৫৫৫৯৯৯১১', ['A-001']],
    ['partial phone digits', '5599911', ['A-001']],
    ['code with Bangla digits', 'A-০০৩', ['A-003']],
  ])('search by %s', async (_label, q, codes) => {
    const res = await list(a, { q }).expect(200);
    expect((res.body as StudentsPage).items.map((s) => s.studentCode)).toEqual(codes);
  });

  it('filters by class level and section in the current year', async () => {
    const byClass = await list(a, { classLevelId: a.class6 }).expect(200);
    expect((byClass.body as StudentsPage).items.map((s) => s.studentCode)).toEqual([
      'A-001',
      'A-002',
    ]);
    expect((byClass.body as StudentsPage).total).toBe(2);
    const bySection = await list(a, { classLevelId: a.class6, sectionId: a.sectionB }).expect(200);
    expect((bySection.body as StudentsPage).items.map((s) => s.studentCode)).toEqual(['A-002']);
    // Another tenant's section id matches nothing.
    const foreign = await list(a, { sectionId: b.sectionA }).expect(200);
    expect((foreign.body as StudentsPage).items).toEqual([]);
  });

  it('paginates with a cursor', async () => {
    const first = (await list(a, { limit: 2 }).expect(200)).body as StudentsPage;
    expect(first.items.map((s) => s.studentCode)).toEqual(['A-001', 'A-002']);
    expect(first.total).toBe(4); // the whole match, not the page
    const second = (await list(a, { limit: 2, cursor: first.nextCursor! }).expect(200))
      .body as StudentsPage;
    expect(second.items.map((s) => s.studentCode)).toEqual(['A-003', 'A-005']);
    expect(second.nextCursor).toBeNull();
    expect(second.total).toBeNull(); // counted on the first page only
  });

  it('validates the query', async () => {
    await list(a, { limit: 500 }).expect(400);
    await list(a, { classLevelId: 'not-a-uuid' }).expect(400);
  });

  it('is limited to OWNER, ADMIN and TEACHER', async () => {
    const guardianPhone = randomPhone();
    await withTenant(h.prisma, a.tenantId, async (tx) => {
      const userId = await findOrCreateUser(tx, guardianPhone, 'Guardian');
      await tx.membership.create({ data: { tenantId: a.tenantId, userId, role: 'GUARDIAN' } });
    });
    const guardian = await otpLogin(h, guardianPhone);
    await http(h).get('/students').set(bearer(guardian.accessToken)).expect(403);
  });

  it('GET /students/filters: class levels with current-year sections', async () => {
    const res = await http(h).get('/students/filters').set(bearer(a.token)).expect(200);
    const body = res.body as StudentFilters;
    const class6 = body.classLevels.find((c) => c.id === a.class6)!;
    expect(class6.sections.map((s) => s.name)).toEqual(['A', 'B']);
    expect(body.classLevels.some((c) => c.id === b.class6)).toBe(false);
  });
});

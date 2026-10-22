import { findOrCreateUser, withTenant } from '@jantrik/db';
import {
  addMonths,
  todayIn,
  type StudentFilters,
  type StudentsPage,
  type StudentsSummary,
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

interface Fixture {
  tenantId: string;
  token: string;
  class6: string;
  class9: string;
  sectionA: string;
  sectionB: string;
}

/**
 * A school with sections, enrolled students, a guardian, a soft-deleted student and an unenrolled
 * inactive one.
 */
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
    await add(`${prefix}-002`, 'Karim Mia', 'করিম মিয়া', class6.id, sectionB.id, 2);
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
      data: { tenantId, studentCode: `${prefix}-005`, nameEn: 'Not Enrolled', status: 'INACTIVE' },
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
    expect(body).toMatchObject({ page: 1, pageSize: 50, total: 4 });
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

  it('pages by number, with the whole count on every page', async () => {
    const codes = async (query: Record<string, string | number>) => {
      const body = (await list(a, query).expect(200)).body as StudentsPage;
      return { codes: body.items.map((s) => s.studentCode), total: body.total, page: body.page };
    };
    expect(await codes({ pageSize: 2 })).toEqual({ codes: ['A-001', 'A-002'], total: 4, page: 1 });
    expect(await codes({ pageSize: 2, page: 2 })).toEqual({
      codes: ['A-003', 'A-005'],
      total: 4,
      page: 2,
    });
    expect(await codes({ pageSize: 2, page: 3 })).toEqual({ codes: [], total: 4, page: 3 });
  });

  it.each([
    ['code, descending', { sort: 'code', dir: 'desc' }, ['A-005', 'A-003', 'A-002', 'A-001']],
    // Bangla names first; the student with an English name only comes last.
    ['Bangla name', { sort: 'name' }, ['A-002', 'A-003', 'A-001', 'A-005']],
    ['English name', { sort: 'name', locale: 'en' }, ['A-003', 'A-002', 'A-005', 'A-001']],
    // Descending, the missing Bangla name still comes last.
    [
      'Bangla name, descending',
      { sort: 'name', dir: 'desc' },
      ['A-001', 'A-003', 'A-002', 'A-005'],
    ],
    // Class, section, roll; not enrolled last in either direction.
    ['class', { sort: 'class' }, ['A-001', 'A-002', 'A-003', 'A-005']],
    ['class, descending', { sort: 'class', dir: 'desc' }, ['A-003', 'A-002', 'A-001', 'A-005']],
    ['roll', { sort: 'roll' }, ['A-001', 'A-003', 'A-002', 'A-005']],
  ])('sorts by %s', async (_label, query, codes) => {
    const res = await list(a, query).expect(200);
    expect((res.body as StudentsPage).items.map((s) => s.studentCode)).toEqual(codes);
  });

  it('pages a class-ordered list in that order, across the students not enrolled', async () => {
    const page = async (query: Record<string, string | number>) => {
      const body = (await list(a, query).expect(200)).body as StudentsPage;
      return [body.items.map((s) => s.studentCode), body.total];
    };
    expect(await page({ sort: 'class', dir: 'desc', pageSize: 2, page: 2 })).toEqual([
      ['A-001', 'A-005'],
      4,
    ]);
    expect(await page({ sort: 'roll', pageSize: 3, page: 2 })).toEqual([['A-005'], 4]);
    expect(await page({ sort: 'class', pageSize: 2, page: 3 })).toEqual([[], 4]);
  });

  it('filters by status', async () => {
    const inactive = (await list(a, { status: 'INACTIVE' }).expect(200)).body as StudentsPage;
    expect(inactive.items.map((s) => s.studentCode)).toEqual(['A-005']);
    const active = (await list(a, { status: 'ACTIVE', sort: 'roll' }).expect(200))
      .body as StudentsPage;
    expect(active.total).toBe(3);
  });

  it('validates the query', async () => {
    await list(a, { pageSize: 500 }).expect(400);
    await list(a, { page: 0 }).expect(400);
    await list(a, { sort: 'phone' }).expect(400);
    await list(a, { status: 'DELETED' }).expect(400);
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

  describe('GET /students/summary', () => {
    const summary = (token: string) => http(h).get('/students/summary').set(bearer(token));

    it('by status, active students by class this year, records added per month', async () => {
      const month = todayIn('Asia/Dhaka').slice(0, 7);
      // One added two months ago, one 13 months ago (outside the 12 months).
      await withTenant(h.prisma, a.tenantId, async (tx) => {
        const at = (m: string) => new Date(`${m}-15T06:00:00Z`);
        await tx.student.updateMany({
          where: { studentCode: 'A-003' },
          data: { createdAt: at(addMonths(month, -2)) },
        });
        await tx.student.updateMany({
          where: { studentCode: 'A-005' },
          data: { createdAt: at(addMonths(month, -13)) },
        });
      });
      const r = (await summary(a.token).expect(200)).body as StudentsSummary;
      expect(r.today).toBe(todayIn('Asia/Dhaka'));
      expect(r.byStatus).toEqual({
        ACTIVE: 3,
        INACTIVE: 1,
        GRADUATED: 0,
        TRANSFERRED: 0,
        DROPPED_OUT: 0,
      });
      const count = (id: string) => r.byClass.find((c) => c.classLevel.id === id)?.count;
      expect(count(a.class6)).toBe(2);
      expect(count(a.class9)).toBe(1);
      // Every class is listed (in class order), empty ones too; never another institute's.
      expect(r.byClass.length).toBeGreaterThan(2);
      expect(r.byClass.filter((c) => c.count === 0).length).toBe(r.byClass.length - 2);
      expect(r.byClass.some((c) => c.classLevel.id === b.class6)).toBe(false);
      expect(r.addedByMonth.map((m) => m.month)).toEqual(
        Array.from({ length: 12 }, (_, i) => addMonths(month, i - 11)),
      );
      // A-001 and A-002 this month (the removed A-004 is not counted), A-003 two months ago.
      expect(r.addedByMonth.at(-1)!.count).toBe(2);
      expect(r.addedByMonth.at(-3)!.count).toBe(1);
      expect(r.addedByMonth.reduce((n, m) => n + m.count, 0)).toBe(3);
    });

    it('a new institute: all zero', async () => {
      const t = await createTenant(h);
      const owner = await otpLogin(h, (await addMember(h, t.id, { roles: ['OWNER'] })).phone);
      const r = (await summary(owner.accessToken).expect(200)).body as StudentsSummary;
      expect(Object.values(r.byStatus).every((n) => n === 0)).toBe(true);
      expect(r.byClass.every((c) => c.count === 0)).toBe(true);
      expect(r.addedByMonth.every((m) => m.count === 0)).toBe(true);
    });

    it('owners and admins only', async () => {
      const teacher = await addMember(h, a.tenantId, { roles: ['TEACHER'] });
      await summary((await otpLogin(h, teacher.phone)).accessToken).expect(403);
      const guardian = await addMember(h, a.tenantId, { roles: ['GUARDIAN'] });
      await summary((await otpLogin(h, guardian.phone)).accessToken).expect(403);
    });
  });

  it('GET /students/filters: class levels with current-year sections', async () => {
    const res = await http(h).get('/students/filters').set(bearer(a.token)).expect(200);
    const body = res.body as StudentFilters;
    const class6 = body.classLevels.find((c) => c.id === a.class6)!;
    expect(class6.sections.map((s) => s.name)).toEqual(['A', 'B']);
    expect(body.classLevels.some((c) => c.id === b.class6)).toBe(false);
  });
});

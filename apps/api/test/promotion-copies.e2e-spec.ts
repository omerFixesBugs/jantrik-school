import { findOrCreateUser, withTenant } from '@jantrik/db';
import type { FeeCopyResult, FeeHeadView, TeacherCopyResult } from '@jantrik/shared';
import {
  addMember,
  bearer,
  createHarness,
  http,
  randomPhone,
  yearRange,
  type Harness,
} from './support/harness.js';
import { promotionSchool, type PromotionSchool } from './support/promotion.js';

/** P5 Task 7 (S16, P5-M, P5-N): fee terms, running concessions and teachers into the new year. */
describe('promotion: copies into the new year', () => {
  let h: Harness;
  let s: PromotionSchool;
  let tuition: FeeHeadView;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
  });
  const years = () => ({ fromAcademicYearId: s.thisYear, toAcademicYearId: s.nextYear });

  beforeAll(async () => {
    h = await createHarness();
    s = await promotionSchool(h, { modules: ['FEES', 'EXAMS'] });
    tuition = (
      await api(s.tokens.admin)
        .post('/fees/heads', {
          nameBn: 'মাসিক বেতন',
          nameEn: 'Monthly tuition',
          kind: 'TUITION',
          frequency: 'MONTHLY',
          dueDay: 10,
          fine: { type: 'FLAT', amountPaisa: 5000, capPaisa: null },
        })
        .expect(201)
    ).body as FeeHeadView;
  });

  afterAll(() => h.close());

  it('terms move one year later; a second copy copies nothing; dates outside the year are counted', async () => {
    const admin = api(s.tokens.admin);
    const [y, next] = [s.year, s.year + 1];
    for (const [nameBn, opensOn, dueDate] of [
      ['প্রথম সাময়িক', `${y}-01-01`, `${y}-01-31`],
      ['দ্বিতীয় সাময়িক', `${y}-05-01`, `${y}-05-31`],
      ['বার্ষিক', `${y}-12-20`, `${next}-01-10`],
    ])
      await admin
        .post('/fees/terms', {
          academicYearId: s.thisYear,
          nameBn,
          nameEn: nameBn,
          opensOn,
          dueDate,
        })
        .expect(201);
    const first = (await admin.post('/fees/terms/copy', years()).expect(200)).body as FeeCopyResult;
    expect(first).toEqual({ copied: 3, skipped: 0, outsideYear: 1 });
    const terms = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.feeTerm.findMany({
        where: { academicYearId: s.nextYear },
        orderBy: { opensOn: 'asc' },
        select: { nameBn: true, opensOn: true, dueDate: true },
      }),
    );
    expect(terms.map((t) => [t.nameBn, t.opensOn.toISOString().slice(0, 10)])).toEqual([
      ['প্রথম সাময়িক', `${next}-01-01`],
      ['দ্বিতীয় সাময়িক', `${next}-05-01`],
      ['বার্ষিক', `${next}-12-20`],
    ]);
    expect(terms[2]!.dueDate.toISOString().slice(0, 10)).toBe(`${next + 1}-01-10`);
    const again = (await admin.post('/fees/terms/copy', years()).expect(200)).body as FeeCopyResult;
    expect(again).toEqual({ copied: 0, skipped: 3, outsideYear: 0 });
  });

  it('29 February becomes 28 February in a year without one', async () => {
    // The first leap year after the school's two years, and the year after it.
    const leap = s.year + 2 + ((4 - ((s.year + 2) % 4)) % 4);
    const { leapYear, yearAfter } = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const mk = (year: number) =>
        tx.academicYear.create({ data: { tenantId: s.tenantId, ...yearRange(year) } });
      return { leapYear: (await mk(leap)).id, yearAfter: (await mk(leap + 1)).id };
    });
    await api(s.tokens.admin)
      .post('/fees/terms', {
        academicYearId: leapYear,
        nameBn: 'লিপ',
        nameEn: 'Leap',
        opensOn: `${leap}-02-01`,
        dueDate: `${leap}-02-29`,
      })
      .expect(201);
    await api(s.tokens.admin)
      .post('/fees/terms/copy', { fromAcademicYearId: leapYear, toAcademicYearId: yearAfter })
      .expect(200);
    const [term] = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.feeTerm.findMany({ where: { academicYearId: yearAfter } }),
    );
    expect(term!.dueDate.toISOString().slice(0, 10)).toBe(`${leap + 1}-02-28`);
  });

  it('concessions still running are copied for students enrolled in the new year, from its first day', async () => {
    const admin = api(s.tokens.admin);
    const [promoted, ended, leaver] = s.students.six;
    const concession = (studentId: string) =>
      admin
        .post('/fees/concessions', {
          studentId,
          feeHeadId: tuition.id,
          academicYearId: s.thisYear,
          category: 'FREE_HALF',
          validFrom: `${s.year}-01-01`,
        })
        .expect(201);
    await concession(promoted!.id);
    const endedOne = (await concession(ended!.id)).body as { id: string };
    await admin
      .post(`/fees/concessions/${endedOne.id}/end`, { endedOn: `${s.year}-06-01`, reason: 'Paid' })
      .expect(200);
    await concession(leaver!.id);
    // All three are enrolled in the new year; the third then leaves.
    for (const st of [promoted!, ended!, leaver!])
      await admin
        .post(`/students/${st.id}/enrolments`, {
          academicYearId: s.nextYear,
          classLevelId: s.classes[7],
          sectionId: s.sections.nextYear[7].ka,
          roll: null,
        })
        .expect(201);
    await admin
      .post(`/students/${leaver!.id}/leave`, { status: 'TRANSFERRED', leftOn: `${s.year}-12-31` })
      .expect(200);

    const first = (await admin.post('/fees/concessions/copy', years()).expect(200))
      .body as FeeCopyResult;
    expect(first).toEqual({ copied: 1, skipped: 0 });
    const copied = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.feeConcession.findMany({ where: { academicYearId: s.nextYear } }),
    );
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({
      studentId: promoted!.id,
      feeHeadId: tuition.id,
      category: 'FREE_HALF',
      value: 50,
      endedOn: null,
    });
    expect(copied[0]!.validFrom.toISOString().slice(0, 10)).toBe(`${s.year + 1}-01-01`);
    const again = (await admin.post('/fees/concessions/copy', years()).expect(200))
      .body as FeeCopyResult;
    expect(again).toEqual({ copied: 0, skipped: 1 });
    const audit = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'fee_concessions', entityId: s.nextYear } }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.newValues).toEqual({
      copiedFrom: s.thisYear,
      copied: 1,
      concessions: [{ studentId: promoted!.id, feeHeadId: tuition.id }],
    });
  });

  it('teachers: by class and section name; staff no longer active and deactivated subjects are skipped', async () => {
    const left = await addMember(h, s.tenantId, { roles: ['TEACHER'] });
    const ids = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const [math, english] = await tx.subject.findMany({
        where: { classLevelId: s.classes[6] },
        orderBy: { sortOrder: 'asc' },
        take: 2,
      });
      const sixThisYear = s.sections.thisYear[6].ka;
      await tx.sectionTeacher.create({
        data: {
          tenantId: s.tenantId,
          sectionId: sixThisYear,
          userId: s.userIds.teacher,
          isClassTeacher: true,
        },
      });
      await tx.sectionTeacher.create({
        data: { tenantId: s.tenantId, sectionId: sixThisYear, userId: left.userId },
      });
      for (const subject of [math!, english!])
        await tx.sectionSubjectTeacher.create({
          data: {
            tenantId: s.tenantId,
            sectionId: sixThisYear,
            subjectId: subject.id,
            classLevelId: s.classes[6],
            userId: s.userIds.teacher,
          },
        });
      await tx.subject.update({ where: { id: english!.id }, data: { isActive: false } });
      await tx.membership.updateMany({
        where: { userId: left.userId },
        data: { status: 'DISABLED' },
      });
      return { math: math!.id };
    });
    const copy = () =>
      api(s.tokens.admin)
        .post(`/setup/academic-years/${s.nextYear}/copy-teachers`, {
          fromAcademicYearId: s.thisYear,
          classTeachers: true,
          subjectTeachers: true,
        })
        .expect(200);
    expect((await copy()).body as TeacherCopyResult).toEqual({
      sectionTeachers: 1,
      subjectTeachers: 1,
      skipped: 2,
    });
    const sixNextYear = s.sections.nextYear[6].ka;
    const [teachers, subjects] = await withTenant(h.prisma, s.tenantId, async (tx) => [
      await tx.sectionTeacher.findMany({ where: { sectionId: sixNextYear } }),
      await tx.sectionSubjectTeacher.findMany({ where: { sectionId: sixNextYear } }),
    ]);
    expect(teachers).toEqual([
      expect.objectContaining({ userId: s.userIds.teacher, isClassTeacher: true }),
    ]);
    expect(subjects).toEqual([expect.objectContaining({ subjectId: ids.math })]);
    expect((await copy()).body as TeacherCopyResult).toEqual({
      sectionTeachers: 0,
      subjectTeachers: 0,
      skipped: 4,
    });
  });

  it('a concession ending in the new year is copied with its end; one ending on its first day is not (review NIT 4)', async () => {
    const admin = api(s.tokens.admin);
    const [keepsEnd, endsAtStart] = s.students.seven;
    const end = async (studentId: string, endedOn: string) => {
      const c = (
        await admin
          .post('/fees/concessions', {
            studentId,
            feeHeadId: tuition.id,
            academicYearId: s.thisYear,
            category: 'FREE_FULL',
            validFrom: `${s.year}-01-01`,
          })
          .expect(201)
      ).body as { id: string };
      await admin
        .post(`/fees/concessions/${c.id}/end`, { endedOn, reason: 'Scholarship ends' })
        .expect(200);
    };
    await end(keepsEnd!.id, `${s.year + 1}-03-31`);
    await end(endsAtStart!.id, `${s.year + 1}-01-01`);
    for (const st of [keepsEnd!, endsAtStart!])
      await admin
        .post(`/students/${st.id}/enrolments`, {
          academicYearId: s.nextYear,
          classLevelId: s.classes[8],
          sectionId: s.sections.nextYear[8].ka,
          roll: null,
        })
        .expect(201);
    expect(
      ((await admin.post('/fees/concessions/copy', years()).expect(200)).body as FeeCopyResult)
        .copied,
    ).toBe(1);
    const copied = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.feeConcession.findMany({
        where: { academicYearId: s.nextYear, studentId: { in: [keepsEnd!.id, endsAtStart!.id] } },
      }),
    );
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ studentId: keepsEnd!.id, endedReason: 'Scholarship ends' });
    expect(copied[0]!.endedOn!.toISOString().slice(0, 10)).toBe(`${s.year + 1}-03-31`);
  });

  it('copies only go forward in time (review NIT 3)', async () => {
    const back = { fromAcademicYearId: s.nextYear, toAcademicYearId: s.thisYear };
    expect((await api(s.tokens.admin).post('/fees/terms/copy', back).expect(422)).body.code).toBe(
      'YEAR_ORDER',
    );
    expect(
      (await api(s.tokens.admin).post('/fees/concessions/copy', back).expect(422)).body.code,
    ).toBe('YEAR_ORDER');
    // Amounts too (review round 2).
    expect((await api(s.tokens.admin).post('/fees/amounts/copy', back).expect(422)).body.code).toBe(
      'YEAR_ORDER',
    );
  });

  it('terms and concessions copy only from the year just before (review round 2)', async () => {
    // Years later than the leap-year test's two (at most six years on).
    const later = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.academicYear.create({ data: { tenantId: s.tenantId, ...yearRange(s.year + 10) } }),
    );
    const skip = { fromAcademicYearId: s.thisYear, toAcademicYearId: later.id };
    const terms = await api(s.tokens.admin).post('/fees/terms/copy', skip).expect(422);
    expect(terms.body).toMatchObject({ code: 'YEAR_ORDER', field: 'fromAcademicYearId' });
    await api(s.tokens.admin).post('/fees/concessions/copy', skip).expect(422);
    // Amounts carry no dates: any earlier year will do.
    await api(s.tokens.admin).post('/fees/amounts/copy', skip).expect(200);
  });

  it('a legacy teacher without a staff profile keeps their section in the copy, not a subject (review round 2)', async () => {
    const legacy = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const id = await findOrCreateUser(tx, randomPhone(), 'Legacy');
      await tx.membership.create({ data: { tenantId: s.tenantId, userId: id, role: 'TEACHER' } });
      const subject = await tx.subject.findFirstOrThrow({
        where: { classLevelId: s.classes[9] },
        orderBy: { sortOrder: 'asc' },
      });
      await tx.sectionTeacher.create({
        data: { tenantId: s.tenantId, sectionId: s.sections.thisYear[9].ka, userId: id },
      });
      await tx.sectionSubjectTeacher.create({
        data: {
          tenantId: s.tenantId,
          sectionId: s.sections.thisYear[9].ka,
          subjectId: subject.id,
          classLevelId: s.classes[9],
          userId: id,
        },
      });
      return id;
    });
    await api(s.tokens.admin)
      .post(`/setup/academic-years/${s.nextYear}/copy-teachers`, {
        fromAcademicYearId: s.thisYear,
        classTeachers: true,
        subjectTeachers: true,
      })
      .expect(200);
    const [sections, subjects] = await withTenant(h.prisma, s.tenantId, async (tx) => [
      await tx.sectionTeacher.count({
        where: { userId: legacy, sectionId: s.sections.nextYear[9].ka },
      }),
      await tx.sectionSubjectTeacher.count({
        where: { userId: legacy, sectionId: s.sections.nextYear[9].ka },
      }),
    ]);
    expect(sections).toBe(1);
    expect(subjects).toBe(0);
  });

  it("an accountant's (or a former teacher's) old subject assignment is not copied (review SF1)", async () => {
    const former = await addMember(h, s.tenantId, { roles: ['TEACHER'] });
    const science = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const subject = await tx.subject.findFirstOrThrow({
        where: { classLevelId: s.classes[7] },
        orderBy: { sortOrder: 'asc' },
      });
      await tx.sectionSubjectTeacher.create({
        data: {
          tenantId: s.tenantId,
          sectionId: s.sections.thisYear[7].ka,
          subjectId: subject.id,
          classLevelId: s.classes[7],
          userId: former.userId,
        },
      });
      return subject.id;
    });
    await h.access.setMemberRoles(s.tenantId, former.userId, ['ACCOUNTANT']);
    const res = (
      await api(s.tokens.admin)
        .post(`/setup/academic-years/${s.nextYear}/copy-teachers`, {
          fromAcademicYearId: s.thisYear,
          classTeachers: false,
          subjectTeachers: true,
        })
        .expect(200)
    ).body as TeacherCopyResult;
    expect(res.subjectTeachers).toBe(0);
    const rows = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.sectionSubjectTeacher.count({
        where: { userId: former.userId, subjectId: science, sectionId: s.sections.nextYear[7].ka },
      }),
    );
    expect(rows).toBe(0);
  });

  it('without FEES the fee copies answer 403; teachers and accountants cannot copy', async () => {
    const noFees = await promotionSchool(h, { modules: ['EXAMS'] });
    await api(noFees.tokens.admin)
      .post('/fees/terms/copy', {
        fromAcademicYearId: noFees.thisYear,
        toAcademicYearId: noFees.nextYear,
      })
      .expect(403);
    await api(noFees.tokens.admin)
      .post('/fees/concessions/copy', {
        fromAcademicYearId: noFees.thisYear,
        toAcademicYearId: noFees.nextYear,
      })
      .expect(403);
    await api(s.tokens.teacher).post('/fees/terms/copy', years()).expect(403);
    await api(s.tokens.accountant).post('/fees/concessions/copy', years()).expect(403);
    await api(s.tokens.teacher)
      .post(`/setup/academic-years/${s.nextYear}/copy-teachers`, { fromAcademicYearId: s.thisYear })
      .expect(403);
  });
});

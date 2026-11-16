import { withTenant } from '@jantrik/db';
import type { FeeCopyResult, FeeHeadView, TeacherCopyResult } from '@jantrik/shared';
import { addMember, bearer, createHarness, http, type Harness } from './support/harness.js';
import { promotionSchool, type PromotionSchool } from './support/promotion.js';

/** P5 Task 7 (S16, P5-M, P5-N): fee terms, running concessions and teachers into the new year. */
describe('promotion: copies into the new year', () => {
  let h: Harness;
  let s: PromotionSchool;
  let tuition: FeeHeadView;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
  });
  const years = () => ({ fromAcademicYearId: s.y2026, toAcademicYearId: s.y2027 });

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
    for (const [nameBn, opensOn, dueDate] of [
      ['প্রথম সাময়িক', '2026-01-01', '2026-01-31'],
      ['দ্বিতীয় সাময়িক', '2026-05-01', '2026-05-31'],
      ['বার্ষিক', '2026-12-20', '2027-01-10'],
    ])
      await admin
        .post('/fees/terms', {
          academicYearId: s.y2026,
          nameBn,
          nameEn: nameBn,
          opensOn,
          dueDate,
        })
        .expect(201);
    const first = (await admin.post('/fees/terms/copy', years()).expect(200))
      .body as FeeCopyResult;
    expect(first).toEqual({ copied: 3, skipped: 0, outsideYear: 1 });
    const terms = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.feeTerm.findMany({
        where: { academicYearId: s.y2027 },
        orderBy: { opensOn: 'asc' },
        select: { nameBn: true, opensOn: true, dueDate: true },
      }),
    );
    expect(terms.map((t) => [t.nameBn, t.opensOn.toISOString().slice(0, 10)])).toEqual([
      ['প্রথম সাময়িক', '2027-01-01'],
      ['দ্বিতীয় সাময়িক', '2027-05-01'],
      ['বার্ষিক', '2027-12-20'],
    ]);
    expect(terms[2]!.dueDate.toISOString().slice(0, 10)).toBe('2028-01-10');
    const again = (await admin.post('/fees/terms/copy', years()).expect(200))
      .body as FeeCopyResult;
    expect(again).toEqual({ copied: 0, skipped: 3, outsideYear: 0 });
  });

  it('29 February becomes 28 February in a year without one', async () => {
    const { y2028, y2029 } = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const mk = (name: string) =>
        tx.academicYear.create({
          data: {
            tenantId: s.tenantId,
            name,
            startDate: new Date(`${name}-01-01`),
            endDate: new Date(`${name}-12-31`),
          },
        });
      return { y2028: (await mk('2028')).id, y2029: (await mk('2029')).id };
    });
    await api(s.tokens.admin)
      .post('/fees/terms', {
        academicYearId: y2028,
        nameBn: 'লিপ',
        nameEn: 'Leap',
        opensOn: '2028-02-01',
        dueDate: '2028-02-29',
      })
      .expect(201);
    await api(s.tokens.admin)
      .post('/fees/terms/copy', { fromAcademicYearId: y2028, toAcademicYearId: y2029 })
      .expect(200);
    const [term] = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.feeTerm.findMany({ where: { academicYearId: y2029 } }),
    );
    expect(term!.dueDate.toISOString().slice(0, 10)).toBe('2029-02-28');
  });

  it('concessions still running are copied for students enrolled in the new year, from its first day', async () => {
    const admin = api(s.tokens.admin);
    const [promoted, ended, leaver] = s.students.six;
    const concession = (studentId: string) =>
      admin
        .post('/fees/concessions', {
          studentId,
          feeHeadId: tuition.id,
          academicYearId: s.y2026,
          category: 'FREE_HALF',
          validFrom: '2026-01-01',
        })
        .expect(201);
    await concession(promoted!.id);
    const endedOne = (await concession(ended!.id)).body as { id: string };
    await admin
      .post(`/fees/concessions/${endedOne.id}/end`, { endedOn: '2026-06-01', reason: 'Paid' })
      .expect(200);
    await concession(leaver!.id);
    // All three are enrolled in 2027; the third then leaves.
    for (const st of [promoted!, ended!, leaver!])
      await admin
        .post(`/students/${st.id}/enrolments`, {
          academicYearId: s.y2027,
          classLevelId: s.classes[7],
          sectionId: s.sections[2027][7].ka,
          roll: null,
        })
        .expect(201);
    await admin
      .post(`/students/${leaver!.id}/leave`, { status: 'TRANSFERRED', leftOn: '2026-12-31' })
      .expect(200);

    const first = (await admin.post('/fees/concessions/copy', years()).expect(200))
      .body as FeeCopyResult;
    expect(first).toEqual({ copied: 1, skipped: 0 });
    const copied = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.feeConcession.findMany({ where: { academicYearId: s.y2027 } }),
    );
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({
      studentId: promoted!.id,
      feeHeadId: tuition.id,
      category: 'FREE_HALF',
      value: 50,
      endedOn: null,
    });
    expect(copied[0]!.validFrom.toISOString().slice(0, 10)).toBe('2027-01-01');
    const again = (await admin.post('/fees/concessions/copy', years()).expect(200))
      .body as FeeCopyResult;
    expect(again).toEqual({ copied: 0, skipped: 1 });
    const audit = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'fee_concessions', entityId: s.y2027 } }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.newValues).toEqual({ copiedFrom: s.y2026, copied: 1 });
  });

  it('teachers: by class and section name; staff no longer active and deactivated subjects are skipped', async () => {
    const left = await addMember(h, s.tenantId, { roles: ['TEACHER'] });
    const ids = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const [math, english] = await tx.subject.findMany({
        where: { classLevelId: s.classes[6] },
        orderBy: { sortOrder: 'asc' },
        take: 2,
      });
      const six26 = s.sections[2026][6].ka;
      await tx.sectionTeacher.create({
        data: { tenantId: s.tenantId, sectionId: six26, userId: s.userIds.teacher, isClassTeacher: true },
      });
      await tx.sectionTeacher.create({
        data: { tenantId: s.tenantId, sectionId: six26, userId: left.userId },
      });
      for (const subject of [math!, english!])
        await tx.sectionSubjectTeacher.create({
          data: {
            tenantId: s.tenantId,
            sectionId: six26,
            subjectId: subject.id,
            classLevelId: s.classes[6],
            userId: s.userIds.teacher,
          },
        });
      await tx.subject.update({ where: { id: english!.id }, data: { isActive: false } });
      await tx.membership.updateMany({ where: { userId: left.userId }, data: { status: 'DISABLED' } });
      return { math: math!.id };
    });
    const copy = () =>
      api(s.tokens.admin)
        .post(`/setup/academic-years/${s.y2027}/copy-teachers`, {
          fromAcademicYearId: s.y2026,
          classTeachers: true,
          subjectTeachers: true,
        })
        .expect(200);
    expect((await copy()).body as TeacherCopyResult).toEqual({
      sectionTeachers: 1,
      subjectTeachers: 1,
      skipped: 2,
    });
    const six27 = s.sections[2027][6].ka;
    const [teachers, subjects] = await withTenant(h.prisma, s.tenantId, async (tx) => [
      await tx.sectionTeacher.findMany({ where: { sectionId: six27 } }),
      await tx.sectionSubjectTeacher.findMany({ where: { sectionId: six27 } }),
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

  it('without FEES the fee copies answer 403; teachers and accountants cannot copy', async () => {
    const noFees = await promotionSchool(h, { modules: ['EXAMS'] });
    await api(noFees.tokens.admin)
      .post('/fees/terms/copy', { fromAcademicYearId: noFees.y2026, toAcademicYearId: noFees.y2027 })
      .expect(403);
    await api(noFees.tokens.admin)
      .post('/fees/concessions/copy', {
        fromAcademicYearId: noFees.y2026,
        toAcademicYearId: noFees.y2027,
      })
      .expect(403);
    await api(s.tokens.teacher).post('/fees/terms/copy', years()).expect(403);
    await api(s.tokens.accountant).post('/fees/concessions/copy', years()).expect(403);
    await api(s.tokens.teacher)
      .post(`/setup/academic-years/${s.y2027}/copy-teachers`, { fromAcademicYearId: s.y2026 })
      .expect(403);
  });
});

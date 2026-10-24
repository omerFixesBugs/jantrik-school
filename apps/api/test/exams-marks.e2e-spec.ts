import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import type {
  ExamDetail,
  ExamSheetsGrid,
  LockAllResult,
  MarkSheetHistoryEntry,
  MarkSheetView,
  MySheet,
  SaveMarkSheetResult,
} from '@jantrik/shared';
import { bearer, createHarness, http, type Harness } from './support/harness.js';
import { examsSchool, type ExamsSchool } from './support/exams.js';

describe('marks entry: subject teachers, drafts, submit, lock and corrections', () => {
  let h: Harness;
  let s: ExamsSchool;
  let exam: ExamDetail;
  let ban: string; // exam subject: class 6 Bangla (CQ 70 + MCQ 30)
  let math: string;

  const sheet = (examSubjectId: string, sectionId: string, token = s.tokens.teacher) =>
    http(h).get('/exams/sheets').query({ examSubjectId, sectionId }).set(bearer(token));
  const save = (
    body: {
      examSubjectId?: string;
      sectionId?: string;
      baseVersion: number;
      action?: 'SAVE' | 'SUBMIT';
      entries: { studentId: string; key: string; value: string }[];
      submissionId?: string;
    },
    token = s.tokens.teacher,
  ) =>
    http(h)
      .put('/exams/sheets')
      .set(bearer(token))
      .send({
        examSubjectId: ban,
        sectionId: s.sections.six,
        action: 'SAVE',
        submissionId: randomUUID(),
        ...body,
      });
  /** Every student of 6 ক with the given CQ and MCQ texts. */
  const all = (cq: string[], mcq: string[]) =>
    s.students.six.flatMap((st, i) => [
      { studentId: st.id, key: 'CQ', value: cq[i] ?? '' },
      { studentId: st.id, key: 'MCQ', value: mcq[i] ?? '' },
    ]);
  const sheetAudit = (sheetId: string) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'exam_mark_sheet', entityId: sheetId } }),
    );

  beforeAll(async () => {
    h = await createHarness();
    s = await examsSchool(h);
    await http(h)
      .put(`/exams/setup/sections/${s.sections.six}/subject-teachers`)
      .set(bearer(s.tokens.admin))
      .send({
        assignments: [
          { subjectId: s.subjects.six['BAN'], userIds: [s.userIds.teacher] },
          { subjectId: s.subjects.six['MATH'], userIds: [s.userIds.otherTeacher] },
        ],
      })
      .expect(200);
    exam = (
      await http(h)
        .post('/exams')
        .set(bearer(s.tokens.admin))
        .send({
          academicYearId: s.yearId,
          kind: 'HALF_YEARLY',
          nameBn: 'অর্ধবার্ষিক',
          nameEn: 'Half-yearly',
          startsOn: '2026-06-01',
          endsOn: '2026-06-15',
          resultMode: 'GPA',
        })
        .expect(201)
    ).body as ExamDetail;
    await http(h)
      .put(`/exams/${exam.id}/classes`)
      .set(bearer(s.tokens.admin))
      .send({ classLevelIds: [s.class6] })
      .expect(200);
    exam = (await http(h).post(`/exams/${exam.id}/open`).set(bearer(s.tokens.admin)).expect(200))
      .body as ExamDetail;
    const subjects = exam.classes[0]!.subjects;
    ban = subjects.find((x) => x.subject.code === 'BAN')!.id;
    math = subjects.find((x) => x.subject.code === 'MATH')!.id;
  });
  afterAll(() => h.close());

  it("a teacher's sheets: only their subject in their section", async () => {
    const mine = (await http(h).get('/exams/my-sheets').set(bearer(s.tokens.teacher)).expect(200))
      .body as MySheet[];
    expect(mine.map((m) => [m.subject.code, m.section.name])).toEqual([['BAN', 'ক']]);
    expect(mine[0]).toMatchObject({ status: 'DRAFT', entered: 0, total: 3 });
    const view = (await sheet(ban, s.sections.six).expect(200)).body as MarkSheetView;
    expect(view).toMatchObject({ mode: 'TEACHER', sheet: { id: null, version: 0 } });
    expect(view.examSubject.components.map((c) => c.key)).toEqual(['CQ', 'MCQ']);
    expect(view.students.map((x) => x.roll)).toEqual([1, 2, 3]);
    expect(view.grading?.bands).toHaveLength(7);
    expect(JSON.stringify(view)).not.toContain(s.students.six[0]!.phone);
  });

  it('refuses another subject, another section, and the class teacher without the subject', async () => {
    for (const [es, section] of [
      [math, s.sections.six],
      [ban, s.sections.sixB],
    ] as const) {
      const r = await sheet(es, section).expect(403);
      expect(r.body.code).toBe('NOT_ASSIGNED');
      await save({ examSubjectId: es, sectionId: section, baseVersion: 0, entries: [] }).expect(
        403,
      );
    }
    // The teacher is 6 ক's class teacher, but Science is not theirs.
    const sci = exam.classes[0]!.subjects.find((x) => x.subject.code === 'SCI')!.id;
    await sheet(sci, s.sections.six).expect(403);
    await sheet(ban, s.sections.six, s.tokens.accountant).expect(403);
    await sheet(ban, s.sections.six, s.tokens.guardian).expect(403);
  });

  it('saves a draft with Bangla digits; a retry changes nothing; a stale save conflicts', async () => {
    const submissionId = randomUUID();
    const first = (
      await save({ baseVersion: 0, submissionId, entries: all(['৫৬.৫', '40'], ['২০', '']) }).expect(
        200,
      )
    ).body as SaveMarkSheetResult;
    expect(first).toMatchObject({ replayed: false, sheet: { status: 'DRAFT', version: 1 } });
    expect(first.students[0]!.marks).toEqual({
      CQ: { scoreH: 5650, absent: false },
      MCQ: { scoreH: 2000, absent: false },
    });
    expect(first.students[1]!.marks['MCQ']).toBeUndefined();
    const audit = await sheetAudit(first.sheet.id!);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.newValues)).toContain('"scoreH":5650');

    const retry = (
      await save({ baseVersion: 0, submissionId, entries: all(['৫৬.৫', '40'], ['২০', '']) }).expect(
        200,
      )
    ).body as SaveMarkSheetResult;
    expect(retry).toMatchObject({ replayed: true, sheet: { version: 1 } });
    expect(await sheetAudit(first.sheet.id!)).toHaveLength(1);

    const stale = await save({ baseVersion: 0, entries: all(['1'], []) }).expect(409);
    expect(stale.body).toMatchObject({
      code: 'VERSION_CONFLICT',
      sheet: { sheet: { version: 1 } },
    });
  });

  it('refuses marks above the full marks or with 3 decimals', async () => {
    for (const value of ['71', '56.255', 'x']) {
      const r = await save({ baseVersion: 1, entries: all([value], []) }).expect(422);
      expect(r.body).toMatchObject({
        code: 'INVALID_MARKS',
        studentId: s.students.six[0]!.id,
        key: 'CQ',
      });
    }
  });

  it('submits only when complete (absent counts); edits after submit make it a draft again', async () => {
    const incomplete = await save({
      baseVersion: 1,
      action: 'SUBMIT',
      entries: all(['50', '40', '30'], ['20', '']),
    }).expect(422);
    expect(incomplete.body).toMatchObject({ code: 'INCOMPLETE', missing: 2 });
    const submitted = (
      await save({
        baseVersion: 1,
        action: 'SUBMIT',
        entries: all(['50', '40', 'অ'], ['20', '25', 'a']),
      }).expect(200)
    ).body as SaveMarkSheetResult;
    expect(submitted.sheet).toMatchObject({ status: 'SUBMITTED', version: 2 });
    expect(submitted.students[2]!.marks).toEqual({
      CQ: { scoreH: null, absent: true },
      MCQ: { scoreH: null, absent: true },
    });
    const edited = (
      await save({ baseVersion: 2, entries: all(['51', '40', 'অ'], ['20', '25', 'a']) }).expect(200)
    ).body as SaveMarkSheetResult;
    expect(edited.sheet).toMatchObject({ status: 'DRAFT', version: 3 });
    const again = (
      await save({
        baseVersion: 3,
        action: 'SUBMIT',
        entries: all(['51', '40', 'অ'], ['20', '25', 'a']),
      }).expect(200)
    ).body as SaveMarkSheetResult;
    expect(again.sheet).toMatchObject({ status: 'SUBMITTED', version: 4 });
  });

  it('an admin returns it with a note, then locks it; then only corrections with a reason', async () => {
    const view = (await sheet(ban, s.sections.six).expect(200)).body as MarkSheetView;
    const id = view.sheet.id!;
    await http(h)
      .post(`/exams/sheets/${id}/return`)
      .set(bearer(s.tokens.teacher))
      .send({ note: 'check' })
      .expect(403);
    const returned = (
      await http(h)
        .post(`/exams/sheets/${id}/return`)
        .set(bearer(s.tokens.admin))
        .send({ note: 'Roll 2 MCQ looks wrong' })
        .expect(200)
    ).body as MarkSheetView;
    expect(returned.sheet).toMatchObject({ status: 'DRAFT', returnNote: 'Roll 2 MCQ looks wrong' });
    await http(h).post(`/exams/sheets/${id}/lock`).set(bearer(s.tokens.admin)).expect(409);
    const v = returned.sheet.version;
    await save({
      baseVersion: v,
      action: 'SUBMIT',
      entries: all(['51', '40', 'অ'], ['20', '26', 'a']),
    }).expect(200);
    const locked = (
      await http(h).post(`/exams/sheets/${id}/lock`).set(bearer(s.tokens.admin)).expect(200)
    ).body as MarkSheetView;
    expect(locked.sheet).toMatchObject({ status: 'LOCKED', returnNote: null });
    expect(locked.mode).toBe('CORRECTION');

    const teacherView = (await sheet(ban, s.sections.six).expect(200)).body as MarkSheetView;
    expect(teacherView.mode).toBe('READ_ONLY');
    const refused = await save({
      baseVersion: locked.sheet.version,
      entries: all(['60'], []),
    }).expect(403);
    expect(refused.body.code).toBe('SHEET_LOCKED');
    await save(
      { baseVersion: locked.sheet.version, entries: all(['60'], []) },
      s.tokens.admin,
    ).expect(409);

    const correct = (body: object, token = s.tokens.admin) =>
      http(h).put(`/exams/sheets/${id}/corrections`).set(bearer(token)).send(body);
    const one = [{ studentId: s.students.six[1]!.id, key: 'MCQ', value: '24' }];
    await correct({ baseVersion: locked.sheet.version, entries: one }).expect(400);
    await correct(
      { baseVersion: locked.sheet.version, reason: 'Typo', entries: one },
      s.tokens.teacher,
    ).expect(403);
    const corrected = (
      await correct({
        baseVersion: locked.sheet.version,
        reason: 'Recounted the MCQ script',
        entries: one,
      }).expect(200)
    ).body as MarkSheetView;
    expect(corrected.sheet.status).toBe('LOCKED');
    expect(corrected.students[1]!.marks['MCQ']).toEqual({ scoreH: 2400, absent: false });

    const history = (
      await http(h).get(`/exams/sheets/${id}/history`).set(bearer(s.tokens.admin)).expect(200)
    ).body as MarkSheetHistoryEntry[];
    const last = history.at(-1)!;
    expect(last).toMatchObject({ action: 'CORRECTION', reason: 'Recounted the MCQ script' });
    expect(last.changes).toEqual([
      {
        studentId: s.students.six[1]!.id,
        key: 'MCQ',
        from: { scoreH: 2600, absent: false },
        to: { scoreH: 2400, absent: false },
      },
    ]);
    expect(history.map((x) => x.action)).toEqual(
      expect.arrayContaining(['SAVE', 'SUBMIT', 'RETURN', 'LOCK', 'CORRECTION']),
    );
    await http(h).get(`/exams/sheets/${id}/history`).set(bearer(s.tokens.teacher)).expect(403);

    await http(h)
      .post(`/exams/sheets/${id}/unlock`)
      .set(bearer(s.tokens.admin))
      .send({})
      .expect(400);
    const unlocked = (
      await http(h)
        .post(`/exams/sheets/${id}/unlock`)
        .set(bearer(s.tokens.admin))
        .send({ reason: 'Teacher will recheck' })
        .expect(200)
    ).body as MarkSheetView;
    expect(unlocked.sheet.status).toBe('SUBMITTED');
  });

  it('a changed roster is reported to the teacher (409) with the current students', async () => {
    const newcomer = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const st = await tx.student.create({
        data: { tenantId: s.tenantId, studentCode: `N-${randomUUID().slice(0, 6)}`, nameEn: 'New' },
      });
      await tx.enrolment.create({
        data: {
          tenantId: s.tenantId,
          studentId: st.id,
          academicYearId: s.yearId,
          classLevelId: s.class6,
          sectionId: s.sections.six,
          roll: 4,
        },
      });
      return st.id;
    });
    await http(h)
      .post(`/exams/${exam.id}/candidates/sync`)
      .set(bearer(s.tokens.admin))
      .send({ dryRun: false })
      .expect(200);
    const view = (await sheet(math, s.sections.six, s.tokens.otherTeacher).expect(200))
      .body as MarkSheetView;
    expect(view.students.map((x) => x.studentId)).toContain(newcomer);
    const r = await save(
      {
        examSubjectId: math,
        baseVersion: 0,
        entries: s.students.six.map((st) => ({ studentId: st.id, key: 'CQ', value: '30' })),
      },
      s.tokens.otherTeacher,
    ).expect(409);
    expect(r.body.code).toBe('ROSTER_CHANGED');
    expect(r.body.students.map((x: { studentId: string }) => x.studentId)).toContain(newcomer);
  });

  it('a deleted student leaves every sheet (marks stay in the database)', async () => {
    const gone = s.students.sixB[0]!.id;
    const before = (await sheet(math, s.sections.sixB, s.tokens.admin).expect(200))
      .body as MarkSheetView;
    expect(before.students.map((x) => x.studentId)).toContain(gone);
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.student.update({ where: { id: gone }, data: { deletedAt: new Date() } }),
    );
    const after = (await sheet(math, s.sections.sixB, s.tokens.admin).expect(200))
      .body as MarkSheetView;
    expect(after.students.map((x) => x.studentId)).not.toContain(gone);
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.student.update({ where: { id: gone }, data: { deletedAt: null } }),
    );
  });

  it('the admin grid shows every sheet; lock-all locks the submitted ones', async () => {
    const grid = (
      await http(h).get(`/exams/${exam.id}/sheets`).set(bearer(s.tokens.admin)).expect(200)
    ).body as ExamSheetsGrid;
    const six = grid.classes[0]!;
    expect(six.sections.map((x) => x.name)).toEqual(['ক', 'খ']);
    const banCell = six.cells.find(
      (c) => c.examSubjectId === ban && c.sectionId === s.sections.six,
    )!;
    expect(banCell).toMatchObject({ status: 'SUBMITTED', total: 4 });
    expect(banCell.teachers.map((t) => t.id)).toEqual([s.userIds.teacher]);
    await http(h).get(`/exams/${exam.id}/sheets`).set(bearer(s.tokens.teacher)).expect(403);
    const r = (
      await http(h)
        .post(`/exams/${exam.id}/classes/${six.examClassId}/lock-all`)
        .set(bearer(s.tokens.admin))
        .expect(200)
    ).body as LockAllResult;
    expect(r.locked).toBe(1);
    expect(r.notSubmitted).toBeGreaterThan(0);
  });

  it('a subject with marks keeps its setup: no edits, not dropped from the exam (409)', async () => {
    const view = (await sheet(ban, s.sections.six, s.tokens.admin).expect(200))
      .body as MarkSheetView;
    const r = await http(h)
      .put(`/exams/${exam.id}/subjects/${ban}`)
      .set(bearer(s.tokens.admin))
      .send({
        examDate: '2026-06-02',
        startTime: '10:00',
        passRule: 'PER_COMPONENT',
        components: view.examSubject.components.map((c) => ({ ...c, fullMarks: 50 })),
        passGroups: [],
      })
      .expect(409);
    expect(r.body.code).toBe('MARKS_EXIST');
    const six = exam.classes[0]!;
    const keep = six.subjects.filter((x) => x.id !== ban).map((x) => x.subject.id);
    const dropped = await http(h)
      .put(`/exams/${exam.id}/classes/${six.id}/subjects`)
      .set(bearer(s.tokens.admin))
      .send({ subjectIds: keep })
      .expect(409);
    expect(dropped.body.code).toBe('MARKS_EXIST');
  });

  it("a section of another year is not this exam's sheet", async () => {
    const oldSection = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const year = await tx.academicYear.create({
        data: {
          tenantId: s.tenantId,
          name: '2025',
          startDate: new Date('2025-01-01'),
          endDate: new Date('2025-12-31'),
        },
      });
      return tx.section.create({
        data: { tenantId: s.tenantId, academicYearId: year.id, classLevelId: s.class6, name: 'ক' },
      });
    });
    await sheet(ban, oldSection.id, s.tokens.admin).expect(404);
    await save({ sectionId: oldSection.id, baseVersion: 0, entries: [] }, s.tokens.admin).expect(
      404,
    );
  });

  it('a save that fails later in the request leaves no marks and no audit row', async () => {
    const before = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.examMark.count({ where: { examSubjectId: math } }),
    );
    await http(h)
      .post('/test/exam-sheet-then-fail')
      .set(bearer(s.tokens.admin))
      .send({
        examSubjectId: math,
        sectionId: s.sections.sixB,
        submissionId: randomUUID(),
        baseVersion: 0,
        action: 'SAVE',
        entries: s.students.sixB.map((st) => ({ studentId: st.id, key: 'CQ', value: '30' })),
      })
      .expect(400);
    expect(
      await withTenant(h.prisma, s.tenantId, (tx) =>
        tx.examMark.count({ where: { examSubjectId: math } }),
      ),
    ).toBe(before);
    expect(
      await withTenant(h.prisma, s.tenantId, (tx) =>
        tx.examMarkSheet.count({ where: { examSubjectId: math, sectionId: s.sections.sixB } }),
      ),
    ).toBe(0);
  });
});

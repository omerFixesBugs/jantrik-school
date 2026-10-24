import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import type {
  ExamDetail,
  MarkSheetView,
  PublishCheck,
  RemarksView,
  ReportCards,
  Tabulation,
} from '@jantrik/shared';
import { bearer, createHarness, http, type Harness } from './support/harness.js';
import { examsSchool, type ExamsSchool } from './support/exams.js';
import { fillAndLock } from './support/exam-marks.js';

/**
 * Class 6, 7 subjects (CQ 70 + MCQ 30; English one written paper of 100):
 * six[0] 85% everywhere (GPA 5.00); six[1] and sixB[0] 70% (A, 4.00: a tie broken by roll);
 * six[2] fails Bangla CQ (GPA 0, after every passed student).
 */
const marks = (s: ExamsSchool) => (code: string, key: string, studentId: string) => {
  const level = studentId === s.students.six[0]!.id ? 0.85 : 0.7;
  if (studentId === s.students.six[2]!.id && code === 'BAN' && key === 'CQ') return '20';
  const full = key === 'CQ' ? 70 : key === 'MCQ' ? 30 : 100;
  return String(Math.round(full * level));
};

describe('results: publish, tabulation, report cards, remarks', () => {
  let h: Harness;
  let s: ExamsSchool;
  let exam: ExamDetail;
  let ecId: string;

  const check = async () =>
    (
      await http(h)
        .get(`/exams/${exam.id}/classes/${ecId}/publish-check`)
        .set(bearer(s.tokens.admin))
        .expect(200)
    ).body as PublishCheck;
  const publish = (baseVersion: number) =>
    http(h)
      .post(`/exams/${exam.id}/classes/${ecId}/publish`)
      .set(bearer(s.tokens.admin))
      .send({ baseVersion });
  const tabulation = (token = s.tokens.admin, sectionId?: string) =>
    http(h)
      .get(`/exams/${exam.id}/classes/${ecId}/tabulation`)
      .query(sectionId ? { sectionId } : {})
      .set(bearer(token));

  beforeAll(async () => {
    h = await createHarness();
    s = await examsSchool(h);
    await withTenant(h.prisma, s.tenantId, async (tx) => {
      await tx.student.update({
        where: { id: s.students.six[0]!.id },
        data: { fatherNameEn: 'Abdul Father', nameEn: '=HYPERLINK("x")' },
      });
    });
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
    ecId = exam.classes[0]!.id;
    // One attendance register inside the report card's window (6 ক: all present but roll 3).
    await http(h)
      .put('/attendance/sessions')
      .set(bearer(s.tokens.admin))
      .send({
        sectionId: s.sections.six,
        date: '2026-06-10',
        baseVersion: 0,
        submissionId: randomUUID(),
        records: s.students.six.map((st, i) => ({
          studentId: st.id,
          status: i === 2 ? 'ABSENT' : 'PRESENT',
        })),
      })
      .expect(200);
    // MATH in 6 ক belongs to otherTeacher (a subject teacher, not a teacher of the section).
    await http(h)
      .put(`/exams/setup/sections/${s.sections.six}/subject-teachers`)
      .set(bearer(s.tokens.admin))
      .send({
        assignments: [{ subjectId: s.subjects.six['MATH'], userIds: [s.userIds.otherTeacher] }],
      })
      .expect(200);
  });
  afterAll(() => h.close());

  it('refuses to publish until every sheet is locked and every student complete', async () => {
    const c = await check();
    expect(c.blockers.unlockedSheets).toHaveLength(14);
    expect(c.blockers.incompleteStudents).toBe(4);
    expect(c.isPublished).toBe(false);
    const r = await publish(0).expect(409);
    expect(r.body.code).toBe('NOT_READY');
    // The preview tabulation works before publish.
    const t = (await tabulation().expect(200)).body as Tabulation;
    expect(t).toMatchObject({ source: 'PREVIEW', publishedVersion: 0 });
  });

  it('remarks: the class teacher writes them before publish; another teacher cannot', async () => {
    const put = (token: string, text: string) =>
      http(h)
        .put(`/exams/${exam.id}/remarks`)
        .set(bearer(token))
        .send({ sectionId: s.sections.six, remarks: [{ studentId: s.students.six[0]!.id, text }] });
    await put(s.tokens.otherTeacher, 'x').expect(403);
    const r = (await put(s.tokens.teacher, 'Excellent work').expect(200)).body as RemarksView;
    expect(r.students[0]!.remarks).toBe('Excellent work');
  });

  it('publishes a snapshot with GPA, merit places (ties by roll; failed after passed) and attendance', async () => {
    await fillAndLock(
      h,
      s.tokens.admin,
      exam,
      { [s.class6]: [s.sections.six, s.sections.sixB] },
      marks(s),
    );
    const c = await check();
    expect(c.blockers).toEqual({ unlockedSheets: [], incompleteStudents: 0 });
    const published = (await publish(0).expect(200)).body as PublishCheck;
    expect(published).toMatchObject({ isPublished: true, publishedVersion: 1, stale: false });
    await publish(0).expect(409);

    const t = (await tabulation().expect(200)).body as Tabulation;
    expect(t.source).toBe('PUBLISHED');
    const byId = new Map(t.rows.map((r) => [r.studentId, r]));
    const at = (id: string) => byId.get(id)!;
    expect(at(s.students.six[0]!.id)).toMatchObject({
      gpaH: 500,
      letter: 'A+',
      classPosition: 1,
      sectionPosition: 1,
    });
    expect(at(s.students.sixB[0]!.id)).toMatchObject({
      gpaH: 400,
      classPosition: 2,
      sectionPosition: 1,
    });
    expect(at(s.students.six[1]!.id)).toMatchObject({
      gpaH: 400,
      classPosition: 3,
      sectionPosition: 2,
    });
    expect(at(s.students.six[2]!.id)).toMatchObject({
      gpaH: 0,
      letter: 'F',
      passed: false,
      classPosition: 4,
      sectionPosition: 3,
    });

    const cards = (
      await http(h)
        .get(`/exams/${exam.id}/report-cards`)
        .query({ sectionId: s.sections.six })
        .set(bearer(s.tokens.admin))
        .expect(200)
    ).body as ReportCards;
    expect(cards.cards).toHaveLength(3);
    const top = cards.cards.find((c) => c.student.id === s.students.six[0]!.id)!;
    expect(top).toMatchObject({
      classPosition: 1,
      classSize: 4,
      remarks: 'Excellent work',
      attendance: { present: 1, total: 1, percentH: 10000 },
      student: { fatherNameEn: 'Abdul Father' },
    });
    expect(top.subjects.find((x) => x.subject.code === 'BAN')).toMatchObject({
      letter: 'A+',
      highestH: 8600,
      components: [
        { key: 'CQ', mark: { scoreH: 6000, absent: false } },
        { key: 'MCQ', mark: { scoreH: 2600, absent: false } },
      ],
    });
    expect(
      cards.cards.find((c) => c.student.id === s.students.six[2]!.id)!.attendance,
    ).toMatchObject({
      present: 0,
      total: 1,
    });
    expect(cards.grading?.bands).toHaveLength(7);
  });

  it('five publishes at once from the same version: exactly one wins', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => publish(1)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect((await check()).publishedVersion).toBe(2);
  });

  it("who reads: a teacher of the section yes (with parents' names); a subject-only teacher no", async () => {
    const mine = (await tabulation(s.tokens.teacher, s.sections.six).expect(200))
      .body as Tabulation;
    expect(mine.rows).toHaveLength(3);
    await tabulation(s.tokens.teacher).expect(403);
    await tabulation(s.tokens.teacher, s.sections.sixB).expect(403);
    await tabulation(s.tokens.otherTeacher, s.sections.six).expect(403);
    await tabulation(s.tokens.accountant, s.sections.six).expect(403);
    const cards = (
      await http(h)
        .get(`/exams/${exam.id}/report-cards`)
        .query({ studentId: s.students.six[0]!.id })
        .set(bearer(s.tokens.teacher))
        .expect(200)
    ).body as ReportCards;
    expect(cards.cards[0]!.student.fatherNameEn).toBe('Abdul Father');
    await http(h)
      .get(`/exams/${exam.id}/report-cards`)
      .query({ studentId: s.students.six[0]!.id })
      .set(bearer(s.tokens.otherTeacher))
      .expect(403);
    await http(h)
      .get(`/exams/${exam.id}/classes/${ecId}/publish-check`)
      .set(bearer(s.tokens.teacher))
      .expect(403);
  });

  it('CSV: BOM, ASCII digits, formula-safe names, no phones', async () => {
    const r = await http(h)
      .get(`/exams/${exam.id}/classes/${ecId}/tabulation/csv`)
      .query({ locale: 'en' })
      .set(bearer(s.tokens.admin))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const bytes = r.body as Buffer;
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const text = bytes.toString('utf8');
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(text).not.toMatch(/[০-৯]/);
    for (const st of [...s.students.six, ...s.students.sixB]) expect(text).not.toContain(st.phone);
    expect(text.split('\r\n')[1]).toMatch(/^1,1,ক,/);
  });

  it('a correction after publish shows as stale; republish brings it in', async () => {
    const view = (
      await http(h)
        .get('/exams/sheets')
        .query({
          examSubjectId: exam.classes[0]!.subjects.find((x) => x.subject.code === 'BAN')!.id,
          sectionId: s.sections.six,
        })
        .set(bearer(s.tokens.admin))
        .expect(200)
    ).body as MarkSheetView;
    await http(h)
      .put(`/exams/sheets/${view.sheet.id}/corrections`)
      .set(bearer(s.tokens.admin))
      .send({
        baseVersion: view.sheet.version,
        reason: 'Recounted roll 3 CQ',
        entries: [{ studentId: s.students.six[2]!.id, key: 'CQ', value: '49' }],
      })
      .expect(200);
    expect((await check()).stale).toBe(true);
    // Guardians still see version 2 until the republish.
    expect(
      ((await tabulation().expect(200)).body as Tabulation).rows.find(
        (r) => r.studentId === s.students.six[2]!.id,
      )!.gpaH,
    ).toBe(0);
    await publish(2).expect(200);
    const after = await check();
    expect(after).toMatchObject({ publishedVersion: 3, stale: false });
    expect(
      ((await tabulation().expect(200)).body as Tabulation).rows.find(
        (r) => r.studentId === s.students.six[2]!.id,
      )!.gpaH,
    ).toBe(400);
  });

  it('after publish only an admin changes remarks (then stale); unpublish hides the report cards', async () => {
    const put = (token: string) =>
      http(h)
        .put(`/exams/${exam.id}/remarks`)
        .set(bearer(token))
        .send({
          sectionId: s.sections.six,
          remarks: [{ studentId: s.students.six[1]!.id, text: 'Good' }],
        });
    const refused = await put(s.tokens.teacher).expect(403);
    expect(refused.body.code).toBe('PUBLISHED');
    await put(s.tokens.admin).expect(200);
    expect((await check()).stale).toBe(true);
    await http(h)
      .post(`/exams/${exam.id}/classes/${ecId}/unpublish`)
      .set(bearer(s.tokens.admin))
      .send({ reason: 'x' })
      .expect(400);
    const un = (
      await http(h)
        .post(`/exams/${exam.id}/classes/${ecId}/unpublish`)
        .set(bearer(s.tokens.admin))
        .send({ reason: 'A mistake in the routine' })
        .expect(200)
    ).body as PublishCheck;
    expect(un.isPublished).toBe(false);
    await http(h)
      .get(`/exams/${exam.id}/report-cards`)
      .query({ sectionId: s.sections.six })
      .set(bearer(s.tokens.admin))
      .expect(404);
  });

  it('published results freeze the sheets: no unlock; an archived exam takes no remarks', async () => {
    await publish(3).expect(200);
    const view = (
      await http(h)
        .get('/exams/sheets')
        .query({ examSubjectId: exam.classes[0]!.subjects[0]!.id, sectionId: s.sections.six })
        .set(bearer(s.tokens.admin))
        .expect(200)
    ).body as MarkSheetView;
    const unlock = await http(h)
      .post(`/exams/sheets/${view.sheet.id}/unlock`)
      .set(bearer(s.tokens.admin))
      .send({ reason: 'Recheck please' })
      .expect(409);
    expect(unlock.body.code).toBe('PUBLISHED');
    await http(h).post(`/exams/${exam.id}/archive`).set(bearer(s.tokens.admin)).expect(200);
    const remark = await http(h)
      .put(`/exams/${exam.id}/remarks`)
      .set(bearer(s.tokens.admin))
      .send({
        sectionId: s.sections.six,
        remarks: [{ studentId: s.students.six[0]!.id, text: 'Late' }],
      })
      .expect(409);
    expect(remark.body.code).toBe('NOT_OPEN');
    await http(h).post(`/exams/${exam.id}/reopen`).set(bearer(s.tokens.admin)).expect(200);
  });

  it('without the attendance module the report card has no attendance', async () => {
    const t = await examsSchool(h, { modules: ['EXAMS'] });
    let e = (
      await http(h)
        .post('/exams')
        .set(bearer(t.tokens.admin))
        .send({
          academicYearId: t.yearId,
          kind: 'MODEL_TEST',
          nameBn: 'মডেল টেস্ট',
          nameEn: 'Model test',
          startsOn: '2026-07-01',
          endsOn: '2026-07-01',
          resultMode: 'MARKS',
        })
        .expect(201)
    ).body as ExamDetail;
    await http(h)
      .put(`/exams/${e.id}/classes`)
      .set(bearer(t.tokens.admin))
      .send({ classLevelIds: [t.class6] })
      .expect(200);
    const six = (await http(h).get(`/exams/${e.id}`).set(bearer(t.tokens.admin)).expect(200))
      .body as ExamDetail;
    await http(h)
      .put(`/exams/${e.id}/classes/${six.classes[0]!.id}/subjects`)
      .set(bearer(t.tokens.admin))
      .send({ subjectIds: [t.subjects.six['MATH']] })
      .expect(200);
    e = (await http(h).post(`/exams/${e.id}/open`).set(bearer(t.tokens.admin)).expect(200))
      .body as ExamDetail;
    await fillAndLock(
      h,
      t.tokens.admin,
      e,
      { [t.class6]: [t.sections.six, t.sections.sixB] },
      () => '25',
    );
    await http(h)
      .post(`/exams/${e.id}/classes/${e.classes[0]!.id}/publish`)
      .set(bearer(t.tokens.admin))
      .send({ baseVersion: 0 })
      .expect(200);
    const cards = (
      await http(h)
        .get(`/exams/${e.id}/report-cards`)
        .query({ sectionId: t.sections.six })
        .set(bearer(t.tokens.admin))
        .expect(200)
    ).body as ReportCards;
    expect(cards.cards[0]).toMatchObject({
      attendance: null,
      gpaH: null,
      percentH: 5000,
      classPosition: 1,
    });
    expect(cards.grading).toBeNull();
  });

  it('publishes 600 students within the 15 s request budget', async () => {
    const t = await examsSchool(h, { modules: ['EXAMS'] });
    const N = 600;
    await withTenant(h.prisma, t.tenantId, async (tx) => {
      const students = Array.from({ length: N }, (_, i) => ({
        id: randomUUID(),
        tenantId: t.tenantId,
        studentCode: `P-${i}-${randomUUID().slice(0, 6)}`,
        nameEn: `Student ${i}`,
      }));
      await tx.student.createMany({ data: students });
      await tx.enrolment.createMany({
        data: students.map((st, i) => ({
          tenantId: t.tenantId,
          studentId: st.id,
          academicYearId: t.yearId,
          classLevelId: t.class6,
          sectionId: t.sections.sixB,
          roll: i + 2,
        })),
      });
    });
    let e = (
      await http(h)
        .post('/exams')
        .set(bearer(t.tokens.admin))
        .send({
          academicYearId: t.yearId,
          kind: 'ANNUAL',
          nameBn: 'বার্ষিক',
          nameEn: 'Annual',
          startsOn: '2026-11-01',
          endsOn: '2026-11-20',
          resultMode: 'GPA',
        })
        .expect(201)
    ).body as ExamDetail;
    await http(h)
      .put(`/exams/${e.id}/classes`)
      .set(bearer(t.tokens.admin))
      .send({ classLevelIds: [t.class6] })
      .expect(200);
    e = (await http(h).post(`/exams/${e.id}/open`).set(bearer(t.tokens.admin)).expect(200))
      .body as ExamDetail;
    const ec = e.classes[0]!;
    // Marks and locked sheets straight into the database (the API path is tested above).
    await withTenant(h.prisma, t.tenantId, async (tx) => {
      const candidates = await tx.examCandidate.findMany({
        where: { examId: e.id },
        select: { studentId: true, sectionId: true },
      });
      const comps = await tx.examSubjectComponent.findMany({
        where: { examSubjectId: { in: ec.subjects.map((x) => x.id) } },
        select: { id: true, examSubjectId: true, fullMarks: true },
      });
      const rows = candidates.flatMap((c, i) =>
        comps.map((comp) => ({
          tenantId: t.tenantId,
          examId: e.id,
          examSubjectId: comp.examSubjectId,
          componentId: comp.id,
          studentId: c.studentId,
          scoreH: Math.round(comp.fullMarks * (40 + (i % 60))),
        })),
      );
      for (let i = 0; i < rows.length; i += 5000)
        await tx.examMark.createMany({ data: rows.slice(i, i + 5000) });
      const now = new Date();
      await tx.examMarkSheet.createMany({
        data: ec.subjects.flatMap((es) =>
          [t.sections.six, t.sections.sixB].map((sectionId) => ({
            tenantId: t.tenantId,
            examId: e.id,
            examSubjectId: es.id,
            classLevelId: t.class6,
            sectionId,
            status: 'LOCKED' as const,
            submittedAt: now,
            lockedAt: now,
            version: 1,
          })),
        ),
      });
    });
    const started = Date.now();
    const r = (
      await http(h)
        .post(`/exams/${e.id}/classes/${ec.id}/publish`)
        .set(bearer(t.tokens.admin))
        .send({ baseVersion: 0 })
        .expect(200)
    ).body as PublishCheck;
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.students).toBe(N + 4);
  }, 120_000);
});

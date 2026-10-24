import { findOrCreateUser, withTenant } from '@jantrik/db';
import type { ExamDetail, MarkSheetView } from '@jantrik/shared';
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
import { examsSchool, type ExamsSchool } from './support/exams.js';
import { fillAndLock } from './support/exam-marks.js';

/**
 * Exams and the data rules: no global user names (decision #5) and, for teachers who do not
 * teach the section, no guardian phones or parents' names (decision #19).
 */
describe('exams: what each person sees', () => {
  let h: Harness;
  let s: ExamsSchool;
  let exam: ExamDetail;
  let ecId: string;
  let sheetId: string;
  let subjectTeacher: { userId: string; token: string };
  const SECRET = { name: 'Secret Global Name', nameBn: 'গোপন বিশ্ব নাম' };

  const text = async (token: string, path: string, query: Record<string, string> = {}) => {
    const res = await http(h)
      .get(path)
      .query(query)
      .set(bearer(token))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
      });
    expect(res.status, `${path}: ${String(res.body)}`).toBe(200);
    return res.body as string;
  };

  beforeAll(async () => {
    h = await createHarness();
    s = await examsSchool(h);
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.student.update({
        where: { id: s.students.six[0]!.id },
        data: { fatherNameEn: 'Hidden Father' },
      }),
    );
    // A person known elsewhere by a global name teaches MATH here under a typed name.
    const phone = randomPhone();
    const elsewhere = (await createTenant(h)).id;
    await withTenant(h.prisma, elsewhere, async (tx) => {
      const id = await findOrCreateUser(tx, phone, SECRET.name, SECRET.nameBn);
      await tx.membership.create({ data: { tenantId: elsewhere, userId: id, role: 'GUARDIAN' } });
    });
    const m = await addMember(h, s.tenantId, { phone, roles: ['TEACHER'], name: 'Typed Teacher' });
    // They belong to two institutes: pick this one.
    const login = await otpLogin(h, phone);
    const token = (
      await http(h)
        .post('/auth/switch-tenant')
        .set(bearer(login.accessToken))
        .send({ tenantId: s.tenantId })
        .expect(200)
    ).body.accessToken as string;
    subjectTeacher = { userId: m.userId, token };
    await http(h)
      .put(`/exams/setup/sections/${s.sections.six}/subject-teachers`)
      .set(bearer(s.tokens.admin))
      .send({ assignments: [{ subjectId: s.subjects.six['MATH'], userIds: [m.userId] }] })
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
    ecId = exam.classes[0]!.id;
    const math = exam.classes[0]!.subjects.find((x) => x.subject.code === 'MATH')!.id;
    // The subject teacher saves the MATH sheet, so "updated by" names them.
    const view = (
      await http(h)
        .get('/exams/sheets')
        .query({ examSubjectId: math, sectionId: s.sections.six })
        .set(bearer(subjectTeacher.token))
        .expect(200)
    ).body as MarkSheetView;
    sheetId = (
      await http(h)
        .put('/exams/sheets')
        .set(bearer(subjectTeacher.token))
        .send({
          examSubjectId: math,
          sectionId: s.sections.six,
          submissionId: crypto.randomUUID(),
          baseVersion: 0,
          action: 'SUBMIT',
          entries: view.students.flatMap((st) =>
            view.examSubject.components.map((c) => ({
              studentId: st.studentId,
              key: c.key,
              value: '20',
            })),
          ),
        })
        .expect(200)
    ).body.sheet.id as string;
    await fillAndLock(
      h,
      s.tokens.admin,
      exam,
      { [s.class6]: [s.sections.six, s.sections.sixB] },
      () => '25',
    );
    await http(h)
      .post(`/exams/${exam.id}/classes/${ecId}/publish`)
      .set(bearer(s.tokens.admin))
      .send({ baseVersion: 0 })
      .expect(200);
  });
  afterAll(() => h.close());

  const leaks = (body: string) => [SECRET.name, SECRET.nameBn].filter((x) => body.includes(x));
  const phones = () => [...s.students.six, ...s.students.sixB].map((st) => st.phone);

  it('admin: no exam endpoint returns a global name', async () => {
    const paths: [string, Record<string, string>?][] = [
      ['/exams'],
      [`/exams/${exam.id}`],
      ['/exams/staff'],
      [`/exams/setup/sections/${s.sections.six}/subject-teachers`],
      [`/exams/${exam.id}/sheets`],
      [`/exams/sheets/${sheetId}/history`],
      [
        '/exams/sheets',
        {
          examSubjectId: exam.classes[0]!.subjects.find((x) => x.subject.code === 'MATH')!.id,
          sectionId: s.sections.six,
        },
      ],
      [`/exams/${exam.id}/candidates`],
      [`/exams/${exam.id}/admit-cards`, { sectionId: s.sections.six }],
      [`/exams/${exam.id}/classes/${ecId}/tabulation`],
      [`/exams/${exam.id}/classes/${ecId}/tabulation/csv`, { locale: 'en' }],
      [`/exams/${exam.id}/report-cards`, { sectionId: s.sections.six }],
      [`/exams/${exam.id}/remarks`, { sectionId: s.sections.six }],
      [`/exams/${exam.id}/classes/${ecId}/publish-check`],
      ['/exams/summary'],
    ];
    for (const [path, query] of paths) {
      const body = await text(s.tokens.admin, path, query);
      expect(leaks(body), path).toEqual([]);
    }
    expect(await text(s.tokens.admin, `/exams/sheets/${sheetId}/history`)).toContain(
      'Typed Teacher',
    );
  });

  it('a subject teacher (not a teacher of the section): no phones, no parents, no global names', async () => {
    const math = exam.classes[0]!.subjects.find((x) => x.subject.code === 'MATH')!.id;
    for (const [path, query] of [
      ['/exams/my-sheets'],
      ['/exams/sheets', { examSubjectId: math, sectionId: s.sections.six }],
      ['/exams/summary'],
      [`/exams/${exam.id}`],
    ] as [string, Record<string, string>?][]) {
      const body = await text(subjectTeacher.token, path, query);
      expect(leaks(body), path).toEqual([]);
      for (const phone of phones()) expect(body, path).not.toContain(phone);
      expect(body, path).not.toContain('Hidden Father');
    }
    // Tabulation and report cards belong to the section's teachers.
    await http(h)
      .get(`/exams/${exam.id}/classes/${ecId}/tabulation`)
      .query({ sectionId: s.sections.six })
      .set(bearer(subjectTeacher.token))
      .expect(403);
    await http(h)
      .get(`/exams/${exam.id}/report-cards`)
      .query({ sectionId: s.sections.six })
      .set(bearer(subjectTeacher.token))
      .expect(403);
  });

  it("the section's class teacher: report cards with parents, never phones; CSV without either", async () => {
    const cards = await text(s.tokens.teacher, `/exams/${exam.id}/report-cards`, {
      sectionId: s.sections.six,
    });
    expect(cards).toContain('Hidden Father');
    for (const phone of phones()) expect(cards).not.toContain(phone);
    const csv = await text(s.tokens.teacher, `/exams/${exam.id}/classes/${ecId}/tabulation/csv`, {
      sectionId: s.sections.six,
      locale: 'en',
    });
    expect(csv).not.toContain('Hidden Father');
    for (const phone of phones()) expect(csv).not.toContain(phone);
  });
});

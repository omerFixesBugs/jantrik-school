import { withTenant } from '@jantrik/db';
import type {
  AdmitCards,
  CandidateSyncResult,
  ExamCandidateView,
  ExamDetail,
  ExamListItem,
  ExamRoomView,
  SeatPlan,
} from '@jantrik/shared';
import { bearer, createHarness, http, type Harness } from './support/harness.js';
import { examsSchool, type ExamsSchool } from './support/exams.js';

describe('exams: setup, rosters, admit cards and seats', () => {
  let h: Harness;
  let s: ExamsSchool;
  let other: ExamsSchool;

  const newExam = (body: Record<string, unknown> = {}, token = s.tokens.admin) =>
    http(h)
      .post('/exams')
      .set(bearer(token))
      .send({
        academicYearId: s.yearId,
        kind: 'HALF_YEARLY',
        nameBn: 'অর্ধবার্ষিক পরীক্ষা',
        nameEn: 'Half-yearly exam',
        startsOn: '2026-06-01',
        endsOn: '2026-06-15',
        resultMode: 'GPA',
        ...body,
      });
  const detail = async (id: string, token = s.tokens.admin) =>
    (await http(h).get(`/exams/${id}`).set(bearer(token)).expect(200)).body as ExamDetail;
  const setClasses = (id: string, classLevelIds: string[]) =>
    http(h).put(`/exams/${id}/classes`).set(bearer(s.tokens.admin)).send({ classLevelIds });
  const auditRows = (entity: string) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity }, orderBy: { createdAt: 'asc' } }),
    );

  beforeAll(async () => {
    h = await createHarness();
    s = await examsSchool(h);
    other = await examsSchool(h);
  });
  afterAll(() => h.close());

  it('creates an exam with default merit order and attendance window; staff only', async () => {
    await newExam({}, s.tokens.teacher).expect(403);
    await newExam({}, s.tokens.accountant).expect(403);
    await newExam({ endsOn: '2026-05-01' }).expect(400);
    const outside = await newExam({ startsOn: '2025-12-20' }).expect(422);
    expect(outside.body.code).toBe('OUTSIDE_YEAR');
    const exam = (await newExam().expect(201)).body as ExamDetail;
    expect(exam).toMatchObject({
      status: 'SETUP',
      resultMode: 'GPA',
      meritOrder: ['GPA', 'TOTAL_MARKS', 'ROLL'],
      failedRanking: 'AFTER_PASSED',
      attendance: { from: '2026-01-01', to: '2026-06-15' },
      classes: [],
    });
    // The next GPA exam starts its window the day after this one, and copies its merit order.
    await http(h)
      .patch(`/exams/${exam.id}`)
      .set(bearer(s.tokens.admin))
      .send({ meritOrder: ['GPA', 'FEWER_FAILED_SUBJECTS', 'TOTAL_MARKS', 'ROLL'] })
      .expect(200);
    const annual = (
      await newExam({
        kind: 'ANNUAL',
        nameBn: 'বার্ষিক',
        nameEn: 'Annual',
        startsOn: '2026-11-01',
        endsOn: '2026-11-20',
      }).expect(201)
    ).body as ExamDetail;
    expect(annual).toMatchObject({
      meritOrder: ['GPA', 'FEWER_FAILED_SUBJECTS', 'TOTAL_MARKS', 'ROLL'],
      attendance: { from: '2026-06-16', to: '2026-11-20' },
    });
    const test = (
      await newExam({
        kind: 'CLASS_TEST',
        resultMode: 'MARKS',
        startsOn: '2026-07-10',
        endsOn: '2026-07-10',
        attendance: null,
      }).expect(201)
    ).body as ExamDetail;
    expect(test).toMatchObject({ meritOrder: ['TOTAL_MARKS', 'ROLL'], attendance: null });
    expect((await auditRows('exams')).length).toBeGreaterThanOrEqual(4);
  });

  it('covers classes: each gets its active subjects with the subject setup copied', async () => {
    const exam = (await newExam().expect(201)).body as ExamDetail;
    await setClasses(exam.id, [s.class6, s.class9, other.class9]).expect(422);
    const d = (await setClasses(exam.id, [s.class9, s.class6]).expect(200)).body as ExamDetail;
    expect(d.classes.map((c) => c.classLevel.code)).toEqual(['CLASS_6', 'CLASS_9']);
    const nine = d.classes.find((c) => c.classLevel.code === 'CLASS_9')!;
    const ban = nine.subjects.find((x) => x.subject.code === 'BAN')!;
    expect(ban).toMatchObject({ passRule: 'COMBINED', fullMarks: 200, isElective: false });
    expect(ban.passGroups).toEqual([
      { kind: 'CQ', passMarks: 46 },
      { kind: 'MCQ', passMarks: 20 },
    ]);
    expect(nine.subjects.find((x) => x.subject.code === 'HMATH')).toMatchObject({
      isElective: true,
      studyGroupId: s.groups.science,
    });

    // One subject's routine and parts; then drop and re-add a subject.
    const phy = nine.subjects.find((x) => x.subject.code === 'PHY')!;
    const edited = await http(h)
      .put(`/exams/${exam.id}/subjects/${phy.id}`)
      .set(bearer(s.tokens.admin))
      .send({
        examDate: '2026-06-03',
        startTime: '10:00',
        passRule: 'PER_COMPONENT',
        components: [
          { key: 'CQ', kind: 'CQ', nameBn: 'সৃজনশীল', nameEn: 'CQ', fullMarks: 60, passMarks: 20 },
          { key: 'MCQ', kind: 'MCQ', nameBn: 'বহু', nameEn: 'MCQ', fullMarks: 40, passMarks: 13 },
        ],
        passGroups: [],
      })
      .expect(200);
    expect(edited.body).toMatchObject({
      examDate: '2026-06-03',
      startTime: '10:00',
      fullMarks: 100,
    });
    await http(h)
      .put(`/exams/${exam.id}/subjects/${phy.id}`)
      .set(bearer(s.tokens.admin))
      .send({
        examDate: null,
        startTime: '25:00',
        passRule: 'PER_COMPONENT',
        components: [],
        passGroups: [],
      })
      .expect(400);
    const six = d.classes.find((c) => c.classLevel.code === 'CLASS_6')!;
    const keep = six.subjects.filter((x) => x.subject.code !== 'SCI').map((x) => x.subject.id);
    const dropped = (
      await http(h)
        .put(`/exams/${exam.id}/classes/${six.id}/subjects`)
        .set(bearer(s.tokens.admin))
        .send({ subjectIds: keep })
        .expect(200)
    ).body as ExamDetail;
    expect(
      dropped.classes.find((c) => c.id === six.id)!.subjects.map((x) => x.subject.code),
    ).not.toContain('SCI');
    await http(h)
      .put(`/exams/${exam.id}/classes/${six.id}/subjects`)
      .set(bearer(s.tokens.admin))
      .send({ subjectIds: [...keep, s.subjects.nine['PHY']] })
      .expect(422);
  });

  it('opens: the roster is taken; teachers see open exams only; setup-only delete', async () => {
    const exam = (await newExam().expect(201)).body as ExamDetail;
    await http(h).post(`/exams/${exam.id}/open`).set(bearer(s.tokens.admin)).expect(422);
    await setClasses(exam.id, [s.class6, s.class9]).expect(200);
    const teacherList = async () =>
      (
        (await http(h).get('/exams').set(bearer(s.tokens.teacher)).expect(200))
          .body as ExamListItem[]
      ).map((e) => e.id);
    expect(await teacherList()).not.toContain(exam.id);
    await http(h).get(`/exams/${exam.id}`).set(bearer(s.tokens.teacher)).expect(404);

    const opened = (
      await http(h).post(`/exams/${exam.id}/open`).set(bearer(s.tokens.admin)).expect(200)
    ).body as ExamDetail;
    expect(opened).toMatchObject({ status: 'OPEN', candidates: 6 });
    await http(h).post(`/exams/${exam.id}/open`).set(bearer(s.tokens.admin)).expect(409);
    expect(await teacherList()).toContain(exam.id);
    expect((await detail(exam.id, s.tokens.teacher)).status).toBe('OPEN');
    await http(h).delete(`/exams/${exam.id}`).set(bearer(s.tokens.admin)).expect(409);
    // A class with candidates cannot be dropped.
    const r = await setClasses(exam.id, [s.class9]).expect(409);
    expect(r.body.code).toBe('CLASS_IN_USE');

    const candidates = (
      await http(h)
        .get(`/exams/${exam.id}/candidates?sectionId=${s.sections.six}`)
        .set(bearer(s.tokens.admin))
        .expect(200)
    ).body as ExamCandidateView[];
    expect(candidates.map((c) => c.roll)).toEqual([1, 2, 3]);
    expect(JSON.stringify(candidates)).not.toContain(s.students.six[0]!.phone);

    const unused = (await newExam().expect(201)).body as ExamDetail;
    await http(h).delete(`/exams/${unused.id}`).set(bearer(s.tokens.admin)).expect(204);
    await http(h).get(`/exams/${unused.id}`).set(bearer(s.tokens.admin)).expect(404);
    await http(h).get(`/exams/${exam.id}`).set(bearer(other.tokens.admin)).expect(404);
  });

  it('syncs the roster: newcomers, leavers (marks kept) and transfers; dry run first', async () => {
    const t = await examsSchool(h);
    const exam = (
      await http(h)
        .post('/exams')
        .set(bearer(t.tokens.admin))
        .send({
          academicYearId: t.yearId,
          kind: 'TEST',
          nameBn: 'পরীক্ষা',
          nameEn: 'Test',
          startsOn: '2026-08-01',
          endsOn: '2026-08-05',
          resultMode: 'GPA',
        })
        .expect(201)
    ).body as ExamDetail;
    await http(h)
      .put(`/exams/${exam.id}/classes`)
      .set(bearer(t.tokens.admin))
      .send({ classLevelIds: [t.class6] })
      .expect(200);
    await http(h).post(`/exams/${exam.id}/open`).set(bearer(t.tokens.admin)).expect(200);
    const newcomer = await withTenant(h.prisma, t.tenantId, async (tx) => {
      const st = await tx.student.create({
        data: { tenantId: t.tenantId, studentCode: 'NEW-1', nameEn: 'Newcomer' },
      });
      await tx.enrolment.create({
        data: {
          tenantId: t.tenantId,
          studentId: st.id,
          academicYearId: t.yearId,
          classLevelId: t.class6,
          sectionId: t.sections.six,
          roll: 9,
        },
      });
      await tx.enrolment.updateMany({
        where: { studentId: t.students.six[1]!.id },
        data: { sectionId: t.sections.sixB, roll: 5 },
      });
      await tx.student.update({
        where: { id: t.students.six[2]!.id },
        data: { status: 'INACTIVE' },
      });
      return st.id;
    });
    const sync = (dryRun: boolean) =>
      http(h)
        .post(`/exams/${exam.id}/candidates/sync`)
        .set(bearer(t.tokens.admin))
        .send({ dryRun })
        .expect(200);
    const preview = (await sync(true)).body as CandidateSyncResult;
    expect(preview).toMatchObject({
      dryRun: true,
      added: [{ studentId: newcomer }],
      withdrawn: [{ studentId: t.students.six[2]!.id }],
      moved: [{ studentId: t.students.six[1]!.id, from: 'ক', to: 'খ' }],
    });
    // Nothing changed yet.
    const before = (
      await http(h).get(`/exams/${exam.id}/candidates`).set(bearer(t.tokens.admin)).expect(200)
    ).body as ExamCandidateView[];
    expect(before).toHaveLength(4);
    await sync(false);
    const after = (
      await http(h).get(`/exams/${exam.id}/candidates`).set(bearer(t.tokens.admin)).expect(200)
    ).body as ExamCandidateView[];
    expect(after).toHaveLength(5);
    expect(after.find((c) => c.student.id === t.students.six[2]!.id)!.status).toBe('WITHDRAWN');
    expect(after.find((c) => c.student.id === t.students.six[1]!.id)).toMatchObject({
      section: { id: t.sections.sixB },
      roll: 5,
    });
    expect(((await sync(true)).body as CandidateSyncResult).added).toEqual([]);
  });

  it('seats: rooms in order, classes alternating; short capacity refused; admit cards', async () => {
    const exam = (await newExam().expect(201)).body as ExamDetail;
    await setClasses(exam.id, [s.class6, s.class9]).expect(200);
    const nine = (await detail(exam.id)).classes.find((c) => c.classLevel.code === 'CLASS_9')!;
    for (const [code, date] of [
      ['PHY', '2026-06-03'],
      ['ACC', '2026-06-04'],
    ] as const) {
      const sub = nine.subjects.find((x) => x.subject.code === code)!;
      await http(h)
        .put(`/exams/${exam.id}/subjects/${sub.id}`)
        .set(bearer(s.tokens.admin))
        .send({
          examDate: date,
          startTime: '10:00',
          passRule: sub.passRule,
          components: sub.components,
          passGroups: sub.passGroups,
        })
        .expect(200);
    }
    await http(h).post(`/exams/${exam.id}/open`).set(bearer(s.tokens.admin)).expect(200);
    const room = async (name: string, rows: number, cols: number) =>
      (
        await http(h)
          .post('/exams/rooms')
          .set(bearer(s.tokens.admin))
          .send({ name, rows, cols })
          .expect(201)
      ).body as ExamRoomView;
    const small = await room(`S-${exam.id.slice(0, 4)}`, 2, 2);
    const tiny = await room(`T-${exam.id.slice(0, 4)}`, 1, 1);
    const big = await room(`B-${exam.id.slice(0, 4)}`, 2, 3);
    const short = await http(h)
      .post(`/exams/${exam.id}/seats`)
      .set(bearer(s.tokens.admin))
      .send({ roomIds: [small.id, tiny.id] })
      .expect(409);
    expect(short.body).toMatchObject({ code: 'CAPACITY_SHORT', shortBy: 1 });

    const plan = (
      await http(h)
        .post(`/exams/${exam.id}/seats`)
        .set(bearer(s.tokens.admin))
        .send({ roomIds: [small.id, big.id] })
        .expect(200)
    ).body as SeatPlan;
    expect(plan.unseated).toBe(0);
    expect(plan.rooms.map((r) => r.seats.length)).toEqual([4, 2]);
    const first = plan.rooms[0]!.seats;
    // Seat 1 and 2 sit side by side: different classes.
    expect(first[0]!.classLevel.code).not.toBe(first[1]!.classLevel.code);
    expect((await auditRows('exam_candidates')).at(-1)!.newValues).toMatchObject({
      seated: 6,
    });

    const cards = (
      await http(h)
        .get(`/exams/${exam.id}/admit-cards?sectionId=${s.sections.nine}`)
        .set(bearer(s.tokens.admin))
        .expect(200)
    ).body as AdmitCards;
    expect(cards.cards.map((c) => c.roll)).toEqual([1, 2]);
    const science = cards.cards[0]!;
    expect(science.studyGroup?.code).toBe('SCIENCE');
    expect(science.seat).not.toBeNull();
    const codes = science.routine.map((r) => r.subject.code);
    expect(codes).toContain('PHY');
    expect(codes).not.toContain('ACC');
    expect(science.routine.find((r) => r.subject.code === 'PHY')).toMatchObject({
      examDate: '2026-06-03',
      startTime: '10:00',
    });
    const text = JSON.stringify(cards);
    for (const st of s.students.nine) expect(text).not.toContain(st.phone);
    expect(text).not.toMatch(/fatherName|motherName|guardian/i);
    await http(h)
      .get(`/exams/${exam.id}/admit-cards?sectionId=${s.sections.nine}`)
      .set(bearer(s.tokens.teacher))
      .expect(403);

    // The seat plan reads back; clearing it frees the rooms.
    const read = (
      await http(h).get(`/exams/${exam.id}/seats`).set(bearer(s.tokens.admin)).expect(200)
    ).body as SeatPlan;
    expect(read.rooms.map((r) => r.room.id)).toEqual([small.id, big.id]);
    await http(h).delete(`/exams/${exam.id}/seats`).set(bearer(s.tokens.admin)).expect(204);
    expect(
      (
        (await http(h).get(`/exams/${exam.id}/seats`).set(bearer(s.tokens.admin)).expect(200))
          .body as SeatPlan
      ).unseated,
    ).toBe(6);
  });
});

import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import { todayIn } from '@jantrik/shared';
import type {
  ChildResultItem,
  ExamDetail,
  ExamsSummary,
  MarkSheetView,
  ReportCards,
  ResultSmsPreview,
  ResultSmsRun,
  ResultSmsStatus,
} from '@jantrik/shared';
import type { Job } from 'bullmq';
import { SmsProcessor } from '../src/sms/sms.service.js';
import { TenantSmsService } from '../src/sms/tenant-sms.service.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import { bearer, createHarness, http, type Harness } from './support/harness.js';
import { examsSchool, type ExamsSchool } from './support/exams.js';
import { fillAndLock } from './support/exam-marks.js';

describe('published results: guardians, result SMS, dashboard', () => {
  let h: Harness;
  let s: ExamsSchool;
  let exam: ExamDetail;
  let ecId: string;

  const child = (id: string, token = s.tokens.guardian) =>
    http(h).get(`/me/children/${id}/results`).set(bearer(token));
  const publish = (baseVersion: number) =>
    http(h)
      .post(`/exams/${exam.id}/classes/${ecId}/publish`)
      .set(bearer(s.tokens.admin))
      .send({ baseVersion })
      .expect(200);
  const preview = async () =>
    (
      await http(h)
        .post(`/exams/${exam.id}/classes/${ecId}/sms/preview`)
        .set(bearer(s.tokens.admin))
        .expect(200)
    ).body as ResultSmsPreview;
  const send = (expectedRecipients: number) =>
    http(h)
      .post(`/exams/${exam.id}/classes/${ecId}/sms`)
      .set(bearer(s.tokens.admin))
      .send({ expectedRecipients });
  const status = async (runId: string) =>
    (await http(h).get(`/exams/result-sms/${runId}`).set(bearer(s.tokens.admin)).expect(200))
      .body as ResultSmsStatus;

  beforeAll(async () => {
    h = await createHarness();
    s = await examsSchool(h);
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.student.update({ where: { id: s.students.six[0]!.id }, data: { fatherNameEn: 'Abdul' } }),
    );
    exam = (
      await http(h)
        .post('/exams')
        .set(bearer(s.tokens.admin))
        .send({
          academicYearId: s.yearId,
          kind: 'ANNUAL',
          nameBn: 'বার্ষিক পরীক্ষা',
          nameEn: 'Annual exam',
          startsOn: '2026-11-01',
          endsOn: '2026-11-20',
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
    await fillAndLock(
      h,
      s.tokens.admin,
      exam,
      { [s.class6]: [s.sections.six, s.sections.sixB] },
      (_code, key) => (key === 'CQ' ? '60' : key === 'MCQ' ? '25' : '85'),
    );
  });
  afterAll(() => h.close());

  it("the dashboard summary counts sheets and the teacher's pending ones", async () => {
    const admin = (await http(h).get('/exams/summary').set(bearer(s.tokens.admin)).expect(200))
      .body as ExamsSummary;
    expect(admin.current).toMatchObject({
      id: exam.id,
      sheets: { total: 14, locked: 14 },
      classes: 1,
    });
    expect(admin.upcoming.map((e) => e.id)).toContain(exam.id);
    const teacher = (await http(h).get('/exams/summary').set(bearer(s.tokens.teacher)).expect(200))
      .body as ExamsSummary;
    expect(teacher.myPendingSheets).toBe(0);
    await http(h).get('/exams/summary').set(bearer(s.tokens.guardian)).expect(403);
  });

  it('a guardian sees nothing before publish, then only their own child', async () => {
    expect((await child(s.students.six[0]!.id).expect(200)).body).toEqual([]);
    await publish(0);
    const list = (await child(s.students.six[0]!.id).expect(200)).body as ChildResultItem[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      examClassId: ecId,
      exam: { nameEn: 'Annual exam' },
      gpaH: 500,
      gpaDecimals: 2,
      letter: 'A+',
      classPosition: 1,
      classSize: 4,
    });
    const card = (
      await http(h)
        .get(`/me/children/${s.students.six[0]!.id}/results/${ecId}`)
        .set(bearer(s.tokens.guardian))
        .expect(200)
    ).body as ReportCards;
    expect(card.cards).toHaveLength(1);
    expect(card.cards[0]!.student).toMatchObject({
      id: s.students.six[0]!.id,
      fatherNameEn: 'Abdul',
    });
    // Another family's child, another guardian's view: not found. Staff: not a guardian route.
    await child(s.students.six[1]!.id).expect(404);
    await child(s.students.six[0]!.id, s.tokens.otherGuardian).expect(404);
    await http(h)
      .get(`/me/children/${s.students.six[0]!.id}/results/${ecId}`)
      .set(bearer(s.tokens.otherGuardian))
      .expect(404);
    await child(s.students.six[0]!.id, s.tokens.teacher).expect(403);
    await http(h).get(`/exams/${exam.id}`).set(bearer(s.tokens.guardian)).expect(403);
  });

  it('result SMS: preview with cost, a confirmed count, one per student per published version', async () => {
    const p = await preview();
    expect(p).toMatchObject({
      publishedVersion: 1,
      students: 4,
      withoutPhone: 0,
      alreadySent: 0,
      toSend: 4,
    });
    expect(p.sampleText).toContain('জিপিএ');
    expect(p.segments).toBeGreaterThanOrEqual(4);
    const changed = await send(3).expect(409);
    expect(changed.body.code).toBe('PREVIEW_CHANGED');
    const run = (await send(4).expect(202)).body as ResultSmsRun;
    expect(run.queued).toBe(4);
    await vi.waitFor(async () => expect((await status(run.runId)).counts.SENT).toBe(4), {
      timeout: 10_000,
      interval: 100,
    });
    expect(h.sms.sentTo(s.students.six[0]!.phone).at(-1)).toContain('মেধাক্রম ১');
    expect(await preview()).toMatchObject({ alreadySent: 4, toSend: 0 });
    await http(h)
      .post(`/exams/${exam.id}/classes/${ecId}/sms`)
      .set(bearer(s.tokens.teacher))
      .send({ expectedRecipients: 0 })
      .expect(403);
  });

  it('over the daily cap: the rest are skipped, not held, and go out another time', async () => {
    // A correction and republish make a new version (each student may be told again).
    const ban = exam.classes[0]!.subjects.find((x) => x.subject.code === 'BAN')!.id;
    const view = (
      await http(h)
        .get('/exams/sheets')
        .query({ examSubjectId: ban, sectionId: s.sections.six })
        .set(bearer(s.tokens.admin))
        .expect(200)
    ).body as MarkSheetView;
    await http(h)
      .put(`/exams/sheets/${view.sheet.id}/corrections`)
      .set(bearer(s.tokens.admin))
      .send({
        baseVersion: view.sheet.version,
        reason: 'Recounted',
        entries: [{ studentId: s.students.six[1]!.id, key: 'CQ', value: '50' }],
      })
      .expect(200);
    await publish(1);
    const used = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.smsLog.count({ where: { status: { in: ['QUEUED', 'SENT'] } } }),
    );
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.attendanceSettings.update({
        where: { tenantId: s.tenantId },
        data: { dailySmsCap: used + 1 },
      }),
    );
    expect(await preview()).toMatchObject({
      publishedVersion: 2,
      toSend: 4,
      capLeftToday: 1,
      wouldBeSkipped: 3,
    });
    const run = (await send(4).expect(202)).body as ResultSmsRun;
    await vi.waitFor(
      async () =>
        expect(await status(run.runId)).toMatchObject({ counts: { SENT: 1 }, skipped: 3 }),
      { timeout: 10_000, interval: 100 },
    );
    expect(
      await withTenant(h.prisma, s.tenantId, (tx) =>
        tx.smsLog.count({ where: { status: 'HELD_OVER_LIMIT' } }),
      ),
    ).toBe(0);
    await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.attendanceSettings.update({
        where: { tenantId: s.tenantId },
        data: { dailySmsCap: null },
      }),
    );
    const again = await preview();
    expect(again).toMatchObject({ alreadySent: 1, toSend: 3 });
    const rest = (await send(3).expect(202)).body as ResultSmsRun;
    await vi.waitFor(async () => expect((await status(rest.runId)).counts.SENT).toBe(3), {
      timeout: 10_000,
      interval: 100,
    });
  });

  it('a result SMS waiting to go out is cancelled once the results are unpublished', async () => {
    const dedupeKey = `exam-result:${ecId}:v2:test-${randomUUID()}`;
    await h.app.get(TenantJobRunner).run(
      s.tenantId,
      async () => {
        await h.app.get(TenantSmsService).queue({
          purpose: 'EXAM_RESULT',
          phone: s.students.sixB[0]!.phone,
          body: 'test',
          localDate: todayIn('Asia/Dhaka'),
          dedupeKey,
          relatedEntity: `exam_result:${ecId}:v2`,
          relatedId: s.students.sixB[0]!.id,
          delayMs: 3_600_000,
          dailyCap: 1000,
        });
      },
      { actorUserId: s.userIds.admin },
    );
    const log = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.smsLog.findFirstOrThrow({ where: { dedupeKey } }),
    );
    await http(h)
      .post(`/exams/${exam.id}/classes/${ecId}/unpublish`)
      .set(bearer(s.tokens.admin))
      .send({ reason: 'A wrong subject was counted' })
      .expect(200);
    await h.app
      .get(SmsProcessor)
      .process({ name: 'tenant', data: { tenantId: s.tenantId, smsLogId: log.id } } as Job);
    const after = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.smsLog.findUniqueOrThrow({ where: { id: log.id } }),
    );
    expect(after.status).toBe('CANCELLED');
    // Unpublished: the guardian's list is empty again.
    expect((await child(s.students.six[0]!.id).expect(200)).body).toEqual([]);
  });
});

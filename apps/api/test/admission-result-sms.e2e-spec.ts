import { withTenant } from '@jantrik/db';
import {
  todayIn,
  type AdmissionMeritView,
  type AdmissionMoveUpResult,
  type AdmissionResultSmsPreview,
  type AdmissionResultSmsRun,
} from '@jantrik/shared';
import type { Job } from 'bullmq';
import { SmsProcessor } from '../src/sms/sms.service.js';
import { TenantSmsService } from '../src/sms/tenant-sms.service.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import { admissionSchool, api, testClass, type AdmissionSchool } from './support/admission.js';
import { createHarness, type Harness } from './support/harness.js';

/** Sprint 1 P4, task 5: publish, the result SMS (review focus 2 and 4) and the waitlist. */
describe('admission test (P4): publish, result SMS and the waitlist', () => {
  let h: Harness;
  let s: AdmissionSchool;

  const admin = () => api(h, s.tokens.admin);
  const cc = (id: string, path: string) => `/admission/cycle-classes/${id}/${path}`;
  type Score = string | null; // null: absent
  /** Scores entered, built and published; returns the class and its applications' ids. */
  const published = async (marks: Score[], cfg: { selectCount: number; waitlistCount: number }) => {
    const t = await testClass(h, s, marks.length);
    await admin()
      .patch(cc(t.cc, 'test'), { fullMarks: 100, passMarks: 33, ...cfg })
      .expect(200);
    await admin().post(cc(t.cc, 'test-rolls'), { startAt: 1 }).expect(200);
    const ids = t.apps.map((a) => a.id);
    await setScores(t.cc, ids, marks);
    await republish(t.cc);
    return { ...t, ids };
  };
  const setScores = (id: string, ids: string[], marks: Score[]) =>
    admin()
      .put(cc(id, 'scores'), {
        rows: marks.map((m, i) => ({ applicationId: ids[i]!, score: m, absent: m === null })),
      })
      .expect(200);
  const republish = async (id: string) => {
    const view = (await admin().post(cc(id, 'merit')).expect(200)).body as AdmissionMeritView;
    return (await admin().post(cc(id, 'publish'), { builtAt: view.builtAt }).expect(200))
      .body as AdmissionMeritView;
  };
  const rows = async (ids: string[]) => {
    const found = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.admissionApplication.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          status: true,
          statusReason: true,
          resultVersion: true,
          resultWaitlistPosition: true,
          resultFlag: true,
        },
      }),
    );
    return ids.map((id) => found.find((r) => r.id === id)!);
  };
  const preview = async (id: string) =>
    (await admin().get(cc(id, 'result-sms/preview')).expect(200)).body as AdmissionResultSmsPreview;
  const send = (id: string, expected: number) => admin().post(cc(id, 'result-sms'), { expected });
  const runStatus = async (runId: string) =>
    (await admin().get(`/admission/result-sms/${runId}`).expect(200)).body as {
      counts: Record<string, number>;
      skipped: number;
    };
  const withdraw = (id: string) =>
    admin()
      .post(`/admission/applications/${id}/status`, { status: 'WITHDRAWN', reason: 'Gave up' })
      .expect(200);

  const setCap = (dailySmsCap: number) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.attendanceSettings.update({ where: { tenantId: s.tenantId }, data: { dailySmsCap } }),
    );

  beforeAll(async () => {
    h = await createHarness();
    s = await admissionSchool(h);
    // The automatic cap is 2 × active students (none here yet): a cap of its own.
    await setCap(1000);
  });
  afterAll(() => h.close());

  it('publish: statuses as the draft, version 1, rejections with their reason, one audit row; SELECTED may be approved, WAITLISTED not', async () => {
    const t = await published(['90', '80', '70', '60', '20', null], {
      selectCount: 2,
      waitlistCount: 2,
    });
    expect((await rows(t.ids)).map((r) => [r.status, r.statusReason, r.resultVersion])).toEqual([
      ['SELECTED', null, 1],
      ['SELECTED', null, 1],
      ['WAITLISTED', null, 1],
      ['WAITLISTED', null, 1],
      ['REJECTED', 'FAILED', 1],
      ['REJECTED', 'ABSENT', 1],
    ]);
    expect((await admin().get(cc(t.cc, 'test')).expect(200)).body).toMatchObject({
      resultsVersion: 1,
    });
    const audit = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findFirst({ where: { entity: 'admission_merit_publish', entityId: t.cc } }),
    );
    expect(audit?.newValues).toMatchObject({ version: 1 });
    await admin()
      .post(`/admission/applications/${t.ids[0]}/approve`, { sectionId: s.sectionB })
      .expect(200);
    const waitlisted = await admin().post(`/admission/applications/${t.ids[2]}/approve`, {
      sectionId: s.sectionB,
    });
    expect(waitlisted.status).toBe(409);
    expect(waitlisted.body.code).toBe('APPLICATION_NOT_APPROVABLE');
    // The tie-break is fixed once a list is published.
    const tie = await admin().patch(`/admission/cycles/${t.cycle.id}`, { meritTieBreak: 'NONE' });
    expect(tie.status).toBe(409);
    expect(tie.body.code).toBe('RESULTS_PUBLISHED');
  });

  it('review focus 2: corrected and republished: version 2; the admitted one is flagged, never demoted; the withdrawn untouched; SMS only to changed statuses', async () => {
    const t = await published(['90', '80', '70', '60'], { selectCount: 2, waitlistCount: 1 });
    const [a, b, c, d] = t.ids as [string, string, string, string];
    const first = await preview(t.cc);
    expect(first).toMatchObject({ publishedVersion: 1, applications: 4, toSend: 4 });
    const run = (await send(t.cc, 4).expect(202)).body as AdmissionResultSmsRun;
    await vi.waitFor(async () => expect((await runStatus(run.runId)).counts.SENT).toBe(4), {
      timeout: 15_000,
      interval: 200,
    });
    expect((await preview(t.cc)).toSend).toBe(0);
    await admin()
      .post(`/admission/applications/${b}/approve`, { sectionId: s.sectionB })
      .expect(200);
    await withdraw(d);
    // c's score was 7.0, not 70: corrected to 95.
    await setScores(t.cc, [c], ['95']);
    expect(
      ((await admin().get(cc(t.cc, 'test')).expect(200)).body as { changedSincePublish: boolean })
        .changedSincePublish,
    ).toBe(true);
    await republish(t.cc);
    expect((await rows(t.ids)).map((r) => [r.status, r.resultVersion, r.resultFlag])).toEqual([
      ['SELECTED', 2, null],
      ['ADMITTED', 2, 'ADMITTED_NOT_SELECTED'],
      ['SELECTED', 2, null],
      ['WITHDRAWN', 1, null],
    ]);
    expect(a).toBeDefined();
    // Only c's status changed (WAITLISTED → SELECTED) since its last result SMS.
    expect(await preview(t.cc)).toMatchObject({ publishedVersion: 2, toSend: 1 });
  });

  it('review focus 4: over the cap the rest are skipped (SKIP, not HOLD); a changed count is PREVIEW_CHANGED', async () => {
    const t = await published(
      Array.from({ length: 10 }, (_, i) => String(90 - i)),
      { selectCount: 10, waitlistCount: 0 },
    );
    const used = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.smsLog.count({ where: { status: { in: ['QUEUED', 'SENT'] } } }),
    );
    await setCap(used + 6);
    try {
      expect(await preview(t.cc)).toMatchObject({
        toSend: 10,
        capLeftToday: 6,
        wouldBeSkipped: 4,
      });
      const changed = await send(t.cc, 9);
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('PREVIEW_CHANGED');
      const run = (await send(t.cc, 10).expect(202)).body as AdmissionResultSmsRun;
      await vi.waitFor(
        async () =>
          expect(await runStatus(run.runId)).toMatchObject({ counts: { SENT: 6 }, skipped: 4 }),
        { timeout: 15_000, interval: 200 },
      );
      expect(
        await withTenant(h.prisma, s.tenantId, (tx) =>
          tx.smsLog.count({ where: { status: 'HELD_OVER_LIMIT' } }),
        ),
      ).toBe(0);
    } finally {
      await setCap(1000);
    }
    // The skipped ones are still to send.
    expect((await preview(t.cc)).toSend).toBe(4);
  });

  it('a result SMS of an older version still waiting is cancelled after a republish', async () => {
    const t = await published(['90', '80'], { selectCount: 1, waitlistCount: 1 });
    const [a] = t.ids as [string, string];
    const dedupeKey = `admission-result:${t.cc}:v1:${a}:SELECTED:test`;
    await h.app.get(TenantJobRunner).run(
      s.tenantId,
      () =>
        h.app.get(TenantSmsService).queue({
          purpose: 'ADMISSION_RESULT',
          phone: t.apps[0]!.phone,
          body: 'test',
          localDate: todayIn('Asia/Dhaka'),
          dedupeKey,
          relatedEntity: `admission_result:${t.cc}:v1:SELECTED`,
          relatedId: a,
          delayMs: 3_600_000,
          dailyCap: 1000,
        }),
      { actorUserId: s.userIds.admin },
    );
    await setScores(t.cc, t.ids, ['70', '80']);
    await republish(t.cc);
    const log = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.smsLog.findFirstOrThrow({ where: { dedupeKey } }),
    );
    await h.app
      .get(SmsProcessor)
      .process({ name: 'tenant', data: { tenantId: s.tenantId, smsLogId: log.id } } as Job);
    const after = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.smsLog.findUniqueOrThrow({ where: { id: log.id } }),
    );
    expect(after.status).toBe('CANCELLED');
  });

  it('move up: a selected applicant withdraws and the first on the waitlist is offered the seat; positions renumber; no free seat or an empty waitlist are refused (P4-G)', async () => {
    const t = await published(['90', '80', '70'], { selectCount: 1, waitlistCount: 2 });
    const [a, b, c] = t.ids as [string, string, string];
    const moveUp = () => admin().post(cc(t.cc, 'move-up'));
    const full = await moveUp();
    expect(full.status).toBe(422);
    expect(full.body.code).toBe('NO_SEAT_FREE');
    await withdraw(a);
    const moved = (await moveUp().expect(200)).body as AdmissionMoveUpResult;
    expect(moved.moved.map((m) => m.applicationId)).toEqual([b]);
    expect((await rows([b, c])).map((r) => [r.status, r.resultWaitlistPosition])).toEqual([
      ['SELECTED', null],
      ['WAITLISTED', 1],
    ]);
    // Nobody has had a result SMS yet: b and c (a withdrew).
    expect((await preview(t.cc)).toSend).toBe(2);
    await withdraw(b);
    await moveUp().expect(200);
    await withdraw(c);
    const empty = await moveUp();
    expect(empty.status).toBe(422);
    expect(empty.body.code).toBe('WAITLIST_EMPTY');
  });
});

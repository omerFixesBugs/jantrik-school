import { withTenant } from '@jantrik/db';
import type { AdmissionMeritView } from '@jantrik/shared';
import {
  admissionSchool,
  api,
  staffApplication,
  testClass,
  type AdmissionSchool,
} from './support/admission.js';
import { createHarness, type Harness } from './support/harness.js';

/** Sprint 1 P4, task 4: scores (audited) and the draft merit list (review focus 1 and 5). */
describe('admission test (P4): scores and the draft merit list', () => {
  let h: Harness;
  let s: AdmissionSchool;

  const admin = () => api(h, s.tokens.admin);
  const cc = (id: string, path: string) => `/admission/cycle-classes/${id}/${path}`;
  const scores = (
    id: string,
    rows: { applicationId: string; score: string | null; absent?: boolean }[],
  ) => admin().put(cc(id, 'scores'), { rows: rows.map((r) => ({ absent: false, ...r })) });
  const build = (id: string) => admin().post(cc(id, 'merit'));
  const publish = (id: string, builtAt: string | null) =>
    admin().post(cc(id, 'publish'), { builtAt: builtAt ?? new Date().toISOString() });
  /** A test class: full marks 100, pass 33, select 2, waitlist 1, rolls issued. */
  const ready = async (n: number, over?: (i: number) => Record<string, unknown>) => {
    const t = await testClass(h, s, n, over);
    await admin()
      .patch(cc(t.cc, 'test'), { fullMarks: 100, passMarks: 33, selectCount: 2, waitlistCount: 1 })
      .expect(200);
    await admin().post(cc(t.cc, 'test-rolls'), { startAt: 1 }).expect(200);
    return t;
  };
  const rowsById = (view: AdmissionMeritView) =>
    Object.fromEntries(view.rows.map((r) => [r.applicationId, r]));
  const statuses = async (ids: string[]) =>
    (
      await withTenant(h.prisma, s.tenantId, (tx) =>
        tx.admissionApplication.findMany({
          where: { id: { in: ids } },
          select: { id: true, status: true },
        }),
      )
    ).reduce<Record<string, string>>((m, r) => ({ ...m, [r.id]: r.status }), {});

  beforeAll(async () => {
    h = await createHarness();
    s = await admissionSchool(h);
  });
  afterAll(() => h.close());

  it('scores: Bangla digits in hundredths, absent; above the full marks or without a roll refused with nothing saved; every change audited', async () => {
    const t = await ready(3);
    const late = await staffApplication(h, s, t.cc, { nameEn: 'No Roll' });
    const [a, b, c] = t.apps.map((x) => x.id) as [string, string, string];
    const saved = (
      await scores(t.cc, [
        { applicationId: a, score: '৮৫.৫০' },
        { applicationId: b, score: null, absent: true },
      ]).expect(200)
    ).body as { applicationId: string; scoreH: number | null; absent: boolean }[];
    expect(saved.find((r) => r.applicationId === a)).toMatchObject({ scoreH: 8550, absent: false });
    expect(saved.find((r) => r.applicationId === b)).toMatchObject({ scoreH: null, absent: true });

    const over = await scores(t.cc, [
      { applicationId: c, score: '70' },
      { applicationId: a, score: '101' },
    ]);
    expect(over.status).toBe(422);
    expect(over.body).toMatchObject({ code: 'SCORE_OUT_OF_RANGE', applicationId: a });
    const noRoll = await scores(t.cc, [{ applicationId: late.id, score: '50' }]);
    expect(noRoll.status).toBe(422);
    expect(noRoll.body).toMatchObject({ code: 'NO_ROLL', applicationId: late.id });
    const stored = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.admissionApplication.findUniqueOrThrow({ where: { id: c }, select: { testScoreH: true } }),
    );
    expect(stored.testScoreH).toBeNull();

    const audits = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'admission_test_score', entityId: a } }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      oldValues: { scoreH: null, absent: false },
      newValues: { scoreH: 8550, absent: false },
    });
    // The full marks cannot drop below a score already entered.
    const low = await admin().patch(cc(t.cc, 'test'), { fullMarks: 80 });
    expect(low.status).toBe(409);
    expect(low.body.code).toBe('SCORES_ABOVE_FULL');
  });

  it('build: rows with neither a score nor absent are counted first; the draft changes no status (P4-E)', async () => {
    const t = await ready(4);
    const [a, b, c, d] = t.apps.map((x) => x.id) as [string, string, string, string];
    await scores(t.cc, [
      { applicationId: a, score: '90' },
      { applicationId: b, score: '85' },
    ]).expect(200);
    const missing = await build(t.cc);
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ code: 'SCORES_MISSING', count: 2 });
    await scores(t.cc, [
      { applicationId: c, score: '20' },
      { applicationId: d, score: null, absent: true },
    ]).expect(200);
    const view = (await build(t.cc).expect(200)).body as AdmissionMeritView;
    const r = rowsById(view);
    expect([a, b, c, d].map((id) => [r[id]!.testResult, r[id]!.meritPosition])).toEqual([
      ['SELECTED', 1],
      ['SELECTED', 2],
      ['FAILED', null],
      ['ABSENT', null],
    ]);
    expect(view).toMatchObject({ stale: false, boundaryTie: 0 });
    expect(view.builtAt).not.toBeNull();
    expect(Object.values(await statuses([a, b, c, d]))).toEqual([
      'SUBMITTED',
      'SUBMITTED',
      'SUBMITTED',
      'SUBMITTED',
    ]);
    // Nothing is published yet.
    expect(r[a]!.published).toBeNull();
  });

  it("the cycle's tie-break orders equal scores; with NONE a tie on the last seat is a warning (P4-A, P4-B)", async () => {
    const dob = ['2019-01-01', '2019-09-01', '2019-05-01'];
    const t = await ready(3, (i) => ({ dateOfBirth: dob[i] }));
    const [a, b, c] = t.apps.map((x) => x.id) as [string, string, string];
    await scores(t.cc, [
      { applicationId: a, score: '90' },
      { applicationId: b, score: '85' },
      { applicationId: c, score: '85' },
    ]).expect(200);
    let r = rowsById((await build(t.cc).expect(200)).body as AdmissionMeritView);
    // OLDER_FIRST: c (born in May) before b (born in September).
    expect([r[c]!.meritPosition, r[c]!.testResult, r[b]!.meritPosition, r[b]!.testResult]).toEqual([
      2,
      'SELECTED',
      3,
      'WAITLISTED',
    ]);
    await admin().patch(`/admission/cycles/${t.cycle.id}`, { meritTieBreak: 'NONE' }).expect(200);
    const none = (await build(t.cc).expect(200)).body as AdmissionMeritView;
    r = rowsById(none);
    expect([r[b]!.meritPosition, r[c]!.meritPosition]).toEqual([2, 2]);
    expect([r[b]!.testResult, r[c]!.testResult]).toEqual(['SELECTED', 'SELECTED']);
    expect(none.boundaryTie).toBe(1);
  });

  it('review focus 5: a change after the build makes it stale; publish refuses a stale or an older build (409 MERIT_STALE), and one never built', async () => {
    const t = await ready(2);
    const [a, b] = t.apps.map((x) => x.id) as [string, string];
    expect((await publish(t.cc, null)).body.code).toBe('MERIT_NOT_BUILT');
    await scores(t.cc, [
      { applicationId: a, score: '90' },
      { applicationId: b, score: '80' },
    ]).expect(200);
    const first = ((await build(t.cc).expect(200)).body as AdmissionMeritView).builtAt;
    // A score that changes no place still makes the build stale.
    await scores(t.cc, [{ applicationId: a, score: '91' }]).expect(200);
    expect(
      ((await admin().get(cc(t.cc, 'merit')).expect(200)).body as AdmissionMeritView).stale,
    ).toBe(true);
    const stale = await publish(t.cc, first);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('MERIT_STALE');
    const second = ((await build(t.cc).expect(200)).body as AdmissionMeritView).builtAt;
    expect((await publish(t.cc, first)).body.code).toBe('MERIT_STALE');
    await publish(t.cc, second).expect(200);
  });
});

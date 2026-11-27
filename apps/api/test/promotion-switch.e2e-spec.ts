import { withTenant } from '@jantrik/db';
import type { PromotionApplyCheck, PromotionRunDetail, SwitchCheck } from '@jantrik/shared';
import { bearer, createHarness, http, type Harness } from './support/harness.js';
import { publishedAnnual, promotionSchool, type PromotionSchool } from './support/promotion.js';

/** P5 Task 8 (review focus 3): what is left before switching to the new year. */
describe('promotion: the switch check', () => {
  let h: Harness;
  let s: PromotionSchool;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
  });
  const switchCheck = async () =>
    (await api(s.tokens.admin).get(`/promotions/switch-check?toYearId=${s.nextYear}`).expect(200))
      .body as SwitchCheck;
  const createRun = async (n: 6 | 7 | 10) =>
    (
      await api(s.tokens.admin)
        .post('/promotions', {
          fromYearId: s.thisYear,
          toYearId: s.nextYear,
          classLevelId: s.classes[n],
        })
        .expect(201)
    ).body as PromotionRunDetail;
  const applyAndWait = async (runId: string) => {
    const { version } = (await api(s.tokens.admin).get(`/promotions/${runId}/apply-check`))
      .body as PromotionApplyCheck;
    await api(s.tokens.admin).post(`/promotions/${runId}/apply`, { version }).expect(200);
    await vi.waitFor(
      async () =>
        expect(
          ((await api(s.tokens.admin).get(`/promotions/${runId}`)).body as PromotionRunDetail)
            .status,
        ).toBe('APPLIED'),
      { timeout: 20_000, interval: 200 },
    );
  };

  beforeAll(async () => {
    h = await createHarness();
    s = await promotionSchool(h);
  });

  afterAll(() => h.close());

  it('lists classes without a run, unapplied runs, unpublished annual results, students not carried over and missing rolls', async () => {
    const six = await createRun(6);
    const first = await switchCheck();
    expect(first).toMatchObject({
      toYear: { id: s.nextYear, isCurrent: false },
      fromYear: { id: s.thisYear },
      clean: false,
      notCarriedOver: 8,
      withoutRoll: 0,
    });
    expect(first.classesWithoutRun.map((c) => [c.id, c.students])).toEqual([
      [s.classes[7], 2],
      [s.classes[10], 2],
    ]);
    expect(first.runsNotApplied).toEqual([
      expect.objectContaining({ runId: six.id, status: 'DRAFT', pending: 4 }),
    ]);
    // Classes 7 and 10 have students but no published ANNUAL exam.
    expect(first.classesWithoutPublishedAnnual.map((c) => c.id)).toEqual([
      s.classes[7],
      s.classes[10],
    ]);
  });

  it('lists nothing once everything is done; it never switches the year itself, the existing switch still does', async () => {
    const admin = api(s.tokens.admin);
    await withTenant(h.prisma, s.tenantId, async (tx) => {
      for (const [n, list] of [
        [7, s.students.seven],
        [10, s.students.ten],
      ] as const)
        await publishedAnnual(
          tx,
          s.tenantId,
          s.thisYear,
          s.classes[n],
          list.map((st, i) => ({
            student: st,
            sectionId: s.sections.thisYear[n].ka,
            passed: true,
            place: i + 1,
          })),
        );
    });
    const runs = (await admin.get(`/promotions?toYearId=${s.nextYear}`).expect(200)).body as {
      runs: { id: string }[];
    };
    for (const r of runs.runs) await applyAndWait(r.id);
    for (const n of [7, 10] as const) await applyAndWait((await createRun(n)).id);
    const beforeRolls = await switchCheck();
    expect(beforeRolls).toMatchObject({
      classesWithoutRun: [],
      runsNotApplied: [],
      classesWithoutPublishedAnnual: [],
      notCarriedOver: 0,
      withoutRoll: 6,
      clean: false,
    });
    for (const n of [6, 7, 8] as const) {
      const p = (
        await admin
          .get(`/promotions/rolls?toYearId=${s.nextYear}&classLevelId=${s.classes[n]}`)
          .expect(200)
      ).body as {
        version: string;
        sections: {
          section: { id: string };
          rows: { enrolmentId: string; proposed: number | null }[];
        }[];
      };
      const sections = p.sections
        .map((x) => ({
          sectionId: x.section.id,
          rolls: x.rows
            .filter((r) => r.proposed !== null)
            .map((r) => ({ enrolmentId: r.enrolmentId, roll: r.proposed! })),
        }))
        .filter((x) => x.rolls.length > 0);
      if (sections.length === 0) continue;
      await admin
        .put('/promotions/rolls', {
          toYearId: s.nextYear,
          classLevelId: s.classes[n],
          version: p.version,
          sections,
        })
        .expect(200);
    }
    const done = await switchCheck();
    expect(done).toMatchObject({ withoutRoll: 0, clean: true });
    // The check never switched the year.
    const current = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } }),
    );
    expect(current.id).toBe(s.thisYear);
    await admin.post(`/setup/academic-years/${s.nextYear}/current`).expect(200);
    expect((await switchCheck()).toYear.isCurrent).toBe(true);
  });

  it('teachers cannot read it', async () => {
    await api(s.tokens.teacher).get(`/promotions/switch-check?toYearId=${s.nextYear}`).expect(403);
  });
});

import { withTenant } from '@jantrik/db';
import type {
  PromotionApplyCheck,
  PromotionRunDetail,
  RollsPreview,
  StudentProfile,
} from '@jantrik/shared';
import { bearer, createHarness, http, randomPhone, type Harness } from './support/harness.js';
import { promotionSchool, type PromotionSchool } from './support/promotion.js';

/** P5 Task 6 (S15, P5-A, review focus 5): rolls numbered per class after promotion. */
describe('promotion: numbering the rolls', () => {
  let h: Harness;
  let s: PromotionSchool;
  let admitWithRoll: string;
  let admitWithout: string;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
  });
  const preview = async () =>
    (
      await api(s.tokens.admin)
        .get(`/promotions/rolls?toYearId=${s.nextYear}&classLevelId=${s.classes[7]}`)
        .expect(200)
    ).body as RollsPreview;
  const admit = async (name: string, roll: number | null) =>
    (
      (
        await api(s.tokens.admin)
          .post('/students', {
            nameBn: name,
            guardians: [
              { phone: randomPhone(), nameBn: 'অভিভাবক', relation: 'MOTHER', isPrimary: true },
            ],
            enrolment: {
              academicYearId: s.nextYear,
              classLevelId: s.classes[7],
              sectionId: s.sections.nextYear[7].ka,
              roll,
            },
          })
          .expect(201)
      ).body as StudentProfile
    ).id;
  const applyRun = async (runId: string) => {
    const { version } = (await api(s.tokens.admin).get(`/promotions/${runId}/apply-check`))
      .body as PromotionApplyCheck;
    await api(s.tokens.admin).post(`/promotions/${runId}/apply`, { version }).expect(200);
  };

  beforeAll(async () => {
    h = await createHarness();
    s = await promotionSchool(h);
    const admin = api(s.tokens.admin);
    const six = (
      await admin
        .post('/promotions', {
          fromYearId: s.thisYear,
          toYearId: s.nextYear,
          classLevelId: s.classes[6],
        })
        .expect(201)
    ).body as PromotionRunDetail;
    const seven = (
      await admin
        .post('/promotions', {
          fromYearId: s.thisYear,
          toYearId: s.nextYear,
          classLevelId: s.classes[7],
        })
        .expect(201)
    ).body as PromotionRunDetail;
    // Class 7's two students repeat (into 7 ক).
    await admin
      .put(`/promotions/${seven.id}/rows`, {
        rows: seven.rows.map((r) => ({
          id: r.id,
          decision: 'REPEAT',
          targetClassLevelId: s.classes[7],
          targetSectionId: s.sections.nextYear[7].ka,
        })),
      })
      .expect(200);
    // One after the other: a running apply changes the other run's capacity figures (its check).
    for (const id of [six.id, seven.id]) {
      await applyRun(id);
      await vi.waitFor(
        async () =>
          expect(((await admin.get(`/promotions/${id}`)).body as PromotionRunDetail).status).toBe(
            'APPLIED',
          ),
        { timeout: 20_000, interval: 200 },
      );
    }
    admitWithRoll = await admit('জামাল', 3);
    admitWithout = await admit('বাবলু', null);
  });

  afterAll(() => h.close());

  it('proposes promoted (merit), then repeaters (Bangla name), then new admits, skipping the hand-set 3', async () => {
    const p = await preview();
    expect(p.strategies).toEqual({ PROMOTED: 'MERIT', REPEATER: 'NAME_BN', NEW: 'NAME_BN' });
    const ka = p.sections.find((x) => x.section.id === s.sections.nextYear[7].ka)!;
    const proposed = Object.fromEntries(
      ka.rows.map((r) => [r.studentId, { group: r.group, roll: r.roll, proposed: r.proposed }]),
    );
    const [passed, , absent] = s.students.six;
    const [khadija, ritu] = s.students.seven;
    expect(proposed[passed!.id]).toEqual({ group: 'PROMOTED', roll: null, proposed: 1 });
    expect(proposed[absent!.id]).toEqual({ group: 'PROMOTED', roll: null, proposed: 2 });
    expect(proposed[admitWithRoll]).toEqual({ group: 'NEW', roll: 3, proposed: null });
    expect(proposed[ritu!.id]).toEqual({ group: 'REPEATER', roll: null, proposed: 4 });
    expect(proposed[khadija!.id]).toEqual({ group: 'REPEATER', roll: null, proposed: 5 });
    expect(proposed[admitWithout]).toEqual({ group: 'NEW', roll: null, proposed: 6 });
    const kha = p.sections.find((x) => x.section.id === s.sections.nextYear[7].kha)!;
    expect(kha.rows.map((r) => r.proposed)).toEqual([1]);
  });

  it('a MANUAL duplicate is refused, a taken number answers ROLL_TAKEN, a stale preview PREVIEW_CHANGED', async () => {
    const p = await preview();
    const ka = p.sections.find((x) => x.section.id === s.sections.nextYear[7].ka)!;
    const open = ka.rows.filter((r) => r.roll === null);
    const body = (
      rolls: { enrolmentId: string; roll: number | string }[],
      version = p.version,
    ) => ({
      toYearId: s.nextYear,
      classLevelId: s.classes[7],
      version,
      sections: [{ sectionId: s.sections.nextYear[7].ka, rolls }],
    });
    await api(s.tokens.admin)
      .put(
        '/promotions/rolls',
        body([
          { enrolmentId: open[0]!.enrolmentId, roll: 7 },
          { enrolmentId: open[1]!.enrolmentId, roll: 7 },
        ]),
      )
      .expect(400);
    const taken = await api(s.tokens.admin)
      .put('/promotions/rolls', body([{ enrolmentId: open[0]!.enrolmentId, roll: 3 }]))
      .expect(409);
    expect(taken.body).toMatchObject({ code: 'ROLL_TAKEN', roll: 3 });
    // A new admit between the preview and the save.
    const late = await admit('দেরি', null);
    const stale = await api(s.tokens.admin)
      .put('/promotions/rolls', body([{ enrolmentId: open[0]!.enrolmentId, roll: 1 }]))
      .expect(409);
    expect(stale.body.code).toBe('PREVIEW_CHANGED');
    await api(s.tokens.admin).post(`/students/${late}/deactivate`).expect(200);
  });

  it('saves the proposal (Bangla digits typed in a MANUAL edit are saved as ASCII), then proposes nothing', async () => {
    const p = await preview();
    const sections = p.sections.map((x) => ({
      sectionId: x.section.id,
      rolls: x.rows
        .filter((r) => r.roll === null)
        .map((r) => ({
          enrolmentId: r.enrolmentId,
          // The admin typed the last one by hand, in Bangla digits.
          roll: r.studentId === admitWithout ? '১২' : r.proposed!,
        })),
    }));
    const saved = (
      await api(s.tokens.admin)
        .put('/promotions/rolls', {
          toYearId: s.nextYear,
          classLevelId: s.classes[7],
          version: p.version,
          sections,
        })
        .expect(200)
    ).body as RollsPreview;
    expect(saved.sections.flatMap((x) => x.rows).every((r) => r.proposed === null)).toBe(true);
    const rolls = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.enrolment.findMany({
        where: {
          academicYearId: s.nextYear,
          sectionId: s.sections.nextYear[7].ka,
          student: { deletedAt: null },
        },
        select: { studentId: true, roll: true },
      }),
    );
    expect(rolls.find((r) => r.studentId === admitWithout)!.roll).toBe(12);
    expect(rolls.map((r) => r.roll).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 12]);
    // Rolls already set never move: a second preview proposes nothing and keeps them.
    const again = await preview();
    expect(again.sections.flatMap((x) => x.rows).every((r) => r.proposed === null)).toBe(true);
    const audit = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'class_level', entityId: s.classes[7] } }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.newValues).toMatchObject({ step: 'number_rolls', toYearId: s.nextYear });
  });

  it('teachers cannot; another institute sees nothing of it', async () => {
    await api(s.tokens.teacher)
      .get(`/promotions/rolls?toYearId=${s.nextYear}&classLevelId=${s.classes[7]}`)
      .expect(403);
    const other = await promotionSchool(h);
    await api(other.tokens.admin)
      .get(`/promotions/rolls?toYearId=${s.nextYear}&classLevelId=${s.classes[7]}`)
      .expect(404);
  });
});

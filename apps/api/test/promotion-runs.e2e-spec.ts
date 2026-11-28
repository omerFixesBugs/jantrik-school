import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import type { PromotionRunDetail, PromotionRunsOverview } from '@jantrik/shared';
import { bearer, createHarness, http, type Harness } from './support/harness.js';
import { promotionSchool, type PromotionSchool } from './support/promotion.js';

/** P5 Task 4: runs and rows, their defaults (P5-F, P5-G, S15), edits and refresh. */
describe('promotion runs', () => {
  let h: Harness;
  let s: PromotionSchool;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
    patch: (path: string, body: object) => http(h).patch(path).set(bearer(token)).send(body),
  });
  const create = (school: PromotionSchool, classLevelId: string, extra: object = {}) =>
    api(school.tokens.admin).post('/promotions', {
      fromYearId: school.y2026,
      toYearId: school.y2027,
      classLevelId,
      ...extra,
    });
  const rowOf = (run: PromotionRunDetail, studentId: string) =>
    run.rows.find((r) => r.student.id === studentId)!;

  beforeAll(async () => {
    h = await createHarness();
    s = await promotionSchool(h);
  });

  afterAll(() => h.close());

  let six: PromotionRunDetail;

  it('class 6: passed → class 7 by section name, failed → repeat, absent → promote without a result', async () => {
    six = (await create(s, s.classes[6]).expect(201)).body as PromotionRunDetail;
    expect(six).toMatchObject({
      status: 'DRAFT',
      rollStrategy: 'MERIT',
      meritExam: { id: s.annualExamId },
      nextClassLevel: { id: s.classes[7] },
      counts: { total: 4, promote: 3, repeat: 1, leave: 0, pending: 4, noResult: 1 },
    });
    const [passed, failed, absent] = s.students.six;
    expect(rowOf(six, passed!.id)).toMatchObject({
      decision: 'PROMOTE',
      resultPassed: true,
      meritPosition: 2,
      fromRoll: 1,
      targetClassLevel: { id: s.classes[7] },
      targetSection: { id: s.sections[2027][7].ka },
    });
    expect(rowOf(six, failed!.id)).toMatchObject({
      decision: 'REPEAT',
      resultPassed: false,
      targetClassLevel: { id: s.classes[6] },
      targetSection: { id: s.sections[2027][6].ka },
    });
    expect(rowOf(six, absent!.id)).toMatchObject({
      decision: 'PROMOTE',
      noResult: true,
      targetSection: { id: s.sections[2027][7].ka },
    });
    expect(rowOf(six, s.students.sixB[0]!.id)).toMatchObject({
      decision: 'PROMOTE',
      meritPosition: 1,
      targetSection: { id: s.sections[2027][7].kha },
    });
    const audit = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({ where: { entity: 'promotion_run', entityId: six.id } }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'CREATE', newValues: { rows: 4, repeat: 1 } });
  });

  it('class 10 (the top class): everyone leaves as GRADUATED on the last day of 2026', async () => {
    const run = (await create(s, s.classes[10]).expect(201)).body as PromotionRunDetail;
    expect(run.nextClassLevel).toBeNull();
    expect(run.rows).toHaveLength(2);
    for (const r of run.rows)
      expect(r).toMatchObject({
        decision: 'LEAVE',
        leaveStatus: 'GRADUATED',
        leftOn: '2026-12-31',
        targetClassLevel: null,
      });
  });

  it('class 7 has no annual exam: everyone is promoted without a result, ordered by name', async () => {
    const run = (await create(s, s.classes[7]).expect(201)).body as PromotionRunDetail;
    expect(run).toMatchObject({ rollStrategy: 'NAME_BN', meritExam: null });
    expect(run.rows.every((r) => r.decision === 'PROMOTE' && r.noResult)).toBe(true);
    expect(run.rows.every((r) => r.targetClassLevel?.id === s.classes[8])).toBe(true);
    await create(s, s.classes[7]).expect(409);
  });

  it('refuses a second run, a to-year before the from-year, and MERIT without exams', async () => {
    const dup = await create(s, s.classes[6]).expect(409);
    expect(dup.body).toMatchObject({ code: 'RUN_EXISTS', runId: six.id });
    const backwards = await api(s.tokens.admin)
      .post('/promotions', {
        fromYearId: s.y2027,
        toYearId: s.y2026,
        classLevelId: s.classes[8],
      })
      .expect(422);
    expect(backwards.body.code).toBe('YEAR_ORDER');

    const noExams = await promotionSchool(h, { modules: [] });
    const merit = await create(noExams, noExams.classes[6], { rollStrategy: 'MERIT' }).expect(422);
    expect(merit.body).toMatchObject({ code: 'MERIT_NEEDS_EXAMS', reason: 'MODULE' });
    // Without EXAMS the results are not used at all: everyone in class 6 is promoted.
    const plain = (await create(noExams, noExams.classes[6]).expect(201))
      .body as PromotionRunDetail;
    expect(plain).toMatchObject({ rollStrategy: 'NAME_BN', meritExam: null });
    expect(plain.rows.every((r) => r.decision === 'PROMOTE' && r.noResult)).toBe(true);
  });

  it('bulk edit: targets must fit; a valid edit is saved and audited', async () => {
    const admin = api(s.tokens.admin);
    const passed = rowOf(six, s.students.six[0]!.id);
    const failed = rowOf(six, s.students.six[1]!.id);
    const repeatInto7 = await admin
      .put(`/promotions/${six.id}/rows`, {
        rows: [{ id: failed.id, decision: 'REPEAT', targetClassLevelId: s.classes[7] }],
      })
      .expect(422);
    expect(repeatInto7.body).toMatchObject({ code: 'TARGET_INVALID', rowIds: [failed.id] });
    const wrongSection = await admin
      .put(`/promotions/${six.id}/rows`, {
        rows: [
          {
            id: passed.id,
            decision: 'PROMOTE',
            targetClassLevelId: s.classes[7],
            targetSectionId: s.sections[2027][8].ka,
          },
        ],
      })
      .expect(422);
    expect(wrongSection.body.rowIds).toEqual([passed.id]);
    const lastYearsSection = await admin
      .put(`/promotions/${six.id}/rows`, {
        rows: [
          {
            id: passed.id,
            decision: 'PROMOTE',
            targetClassLevelId: s.classes[7],
            targetSectionId: s.sections[2026][7].ka,
          },
        ],
      })
      .expect(422);
    expect(lastYearsSection.body.code).toBe('TARGET_INVALID');
    // A leaving row needs a date (schema).
    await admin
      .put(`/promotions/${six.id}/rows`, {
        rows: [{ id: passed.id, decision: 'LEAVE', leaveStatus: 'TRANSFERRED' }],
      })
      .expect(400);
    // More than 500 rows in one call.
    await admin
      .put(`/promotions/${six.id}/rows`, {
        rows: Array.from({ length: 501 }, () => ({
          id: randomUUID(),
          decision: 'REPEAT',
          targetClassLevelId: s.classes[6],
        })),
      })
      .expect(400);

    const edited = (
      await admin
        .put(`/promotions/${six.id}/rows`, {
          rows: [
            {
              id: failed.id,
              decision: 'PROMOTE',
              targetClassLevelId: s.classes[7],
              targetSectionId: s.sections[2027][7].kha,
            },
            {
              id: passed.id,
              decision: 'LEAVE',
              leaveStatus: 'TRANSFERRED',
              leftOn: '২০২৬-১২-১৫',
              leaveReason: 'Moved',
            },
          ],
        })
        .expect(200)
    ).body as PromotionRunDetail;
    expect(rowOf(edited, s.students.six[1]!.id)).toMatchObject({
      decision: 'PROMOTE',
      targetSection: { id: s.sections[2027][7].kha },
    });
    expect(edited.counts).toMatchObject({ promote: 3, repeat: 0, leave: 1 });
    expect(edited.rows.find((r) => r.id === passed.id)).toMatchObject({
      decision: 'LEAVE',
      leftOn: '2026-12-15',
      leaveReason: 'Moved',
      targetSection: null,
    });
    const audit = await withTenant(h.prisma, s.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { entity: 'promotion_run', entityId: six.id, action: 'UPDATE' },
      }),
    );
    expect(audit.at(-1)!.newValues).toMatchObject({ step: 'rows' });
    // Back as it was, for the tests below.
    await admin
      .put(`/promotions/${six.id}/rows`, {
        rows: [
          { id: failed.id, decision: 'REPEAT', targetClassLevelId: s.classes[6] },
          {
            id: passed.id,
            decision: 'PROMOTE',
            targetClassLevelId: s.classes[7],
            targetSectionId: s.sections[2027][7].ka,
          },
        ],
      })
      .expect(200);
  });

  it('refresh adds a student enrolled since, and drops a pending row of one who left', async () => {
    const admin = api(s.tokens.admin);
    const late = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const st = await tx.student.create({
        data: {
          tenantId: s.tenantId,
          studentCode: `L-${randomUUID().slice(0, 8)}`,
          nameBn: 'নতুন',
        },
      });
      await tx.enrolment.create({
        data: {
          tenantId: s.tenantId,
          studentId: st.id,
          academicYearId: s.y2026,
          classLevelId: s.classes[6],
          sectionId: s.sections[2026][6].kha,
          roll: 2,
        },
      });
      return st.id;
    });
    const leaver = s.students.six[2]!;
    await admin
      .post(`/students/${leaver.id}/leave`, { status: 'DROPPED_OUT', leftOn: '2026-11-30' })
      .expect(200);
    const refreshed = (await admin.post(`/promotions/${six.id}/refresh`).expect(200))
      .body as PromotionRunDetail;
    const ids = refreshed.rows.map((r) => r.student.id);
    expect(ids).toContain(late);
    expect(ids).not.toContain(leaver.id);
    expect(rowOf(refreshed, late)).toMatchObject({
      decision: 'PROMOTE',
      noResult: true,
      targetSection: { id: s.sections[2027][7].kha },
    });
    // The leaver comes back for the other tests.
    await admin.post(`/students/${leaver.id}/return`).expect(200);
    await admin.post(`/promotions/${six.id}/refresh`).expect(200);
  });

  it('changing the merit exam takes the results again; MERIT needs one', async () => {
    const admin = api(s.tokens.admin);
    const noExam = await admin.patch(`/promotions/${six.id}`, { meritExamId: null }).expect(422);
    expect(noExam.body).toMatchObject({ code: 'MERIT_NEEDS_EXAMS', reason: 'NO_EXAM' });
    const byName = (
      await admin
        .patch(`/promotions/${six.id}`, { meritExamId: null, rollStrategy: 'NAME_BN' })
        .expect(200)
    ).body as PromotionRunDetail;
    expect(byName.rows.every((r) => r.noResult)).toBe(true);
    // Decisions are not changed by it.
    expect(rowOf(byName, s.students.six[1]!.id).decision).toBe('REPEAT');
    const back = (
      await admin
        .patch(`/promotions/${six.id}`, { meritExamId: s.annualExamId, rollStrategy: 'MERIT' })
        .expect(200)
    ).body as PromotionRunDetail;
    expect(rowOf(back, s.students.sixB[0]!.id).meritPosition).toBe(1);
    await admin.patch(`/promotions/${six.id}`, { meritExamId: randomUUID() }).expect(422);
  });

  it('the overview lists runs with counts and the classes without a run', async () => {
    const view = (await api(s.tokens.admin).get(`/promotions?toYearId=${s.y2027}`).expect(200))
      .body as PromotionRunsOverview;
    expect(view.fromYear?.id).toBe(s.y2026);
    expect(view.runs.map((r) => r.classLevel.id)).toEqual([
      s.classes[6],
      s.classes[7],
      s.classes[10],
    ]);
    expect(view.classesWithoutRun).toEqual([]);
  });

  it('teachers and accountants get 403; another institute gets 404', async () => {
    await api(s.tokens.teacher).get(`/promotions/${six.id}`).expect(403);
    await api(s.tokens.accountant).get(`/promotions?toYearId=${s.y2027}`).expect(403);
    const other = await promotionSchool(h);
    await api(other.tokens.admin).get(`/promotions/${six.id}`).expect(404);
    await api(other.tokens.admin)
      .put(`/promotions/${six.id}/rows`, {
        rows: [{ id: six.rows[0]!.id, decision: 'REPEAT', targetClassLevelId: s.classes[6] }],
      })
      .expect(404);
  });
});

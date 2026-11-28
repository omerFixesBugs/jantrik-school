import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/**
 * A school with 2026 (current) and 2027, class 6 and 7 sections in both years, a student in
 * class 6 ক of 2026, an exam of 2026 and one of 2027, and a draft run of class 6 → 2027.
 */
async function school(app: PrismaClient) {
  const tenant = await createTenant(app);
  const tenantId = tenant.id;
  return withTenant(app, tenantId, async (tx) => {
    const y2026 = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const y2027 = await tx.academicYear.create({
      data: {
        tenantId,
        name: '2027',
        startDate: new Date('2027-01-01'),
        endDate: new Date('2027-12-31'),
      },
    });
    const c6 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_6' } });
    const c7 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_7' } });
    const section = (academicYearId: string, classLevelId: string, name = 'ক') =>
      tx.section.create({ data: { tenantId, academicYearId, classLevelId, name } });
    const six26 = await section(y2026.id, c6.id);
    const seven27 = await section(y2027.id, c7.id);
    const six27 = await section(y2027.id, c6.id);
    const seven26 = await section(y2026.id, c7.id);
    const adminId = await findOrCreateUser(tx, randomPhone(), 'Admin');
    await tx.membership.create({ data: { tenantId, userId: adminId, role: 'ADMIN' } });
    const student = await tx.student.create({
      data: { tenantId, studentCode: `P-${randomUUID().slice(0, 8)}`, nameEn: 'Promo' },
    });
    const enrolment = await tx.enrolment.create({
      data: {
        tenantId,
        studentId: student.id,
        academicYearId: y2026.id,
        classLevelId: c6.id,
        sectionId: six26.id,
        roll: 1,
      },
    });
    const exam = (academicYearId: string) =>
      tx.exam.create({
        data: {
          tenantId,
          academicYearId,
          kind: 'ANNUAL',
          nameBn: 'বার্ষিক',
          nameEn: 'Annual',
          startsOn: new Date('2026-11-01'),
          endsOn: new Date('2026-11-20'),
          resultMode: 'GPA',
          meritOrder: ['GPA', 'ROLL'],
          failedRanking: 'AFTER_PASSED',
          status: 'OPEN',
        },
      });
    const exam26 = await exam(y2026.id);
    const exam27 = await exam(y2027.id);
    const run = await tx.promotionRun.create({
      data: {
        tenantId,
        fromYearId: y2026.id,
        toYearId: y2027.id,
        classLevelId: c6.id,
        rollStrategy: 'NAME_BN',
        createdById: adminId,
      },
    });
    return {
      tenantId,
      y2026: y2026.id,
      y2027: y2027.id,
      c6: c6.id,
      c7: c7.id,
      six26: six26.id,
      six27: six27.id,
      seven26: seven26.id,
      seven27: seven27.id,
      adminId,
      studentId: student.id,
      enrolmentId: enrolment.id,
      exam26: exam26.id,
      exam27: exam27.id,
      runId: run.id,
    };
  });
}

type School = Awaited<ReturnType<typeof school>>;

const promoteRow = (s: School, extra: Record<string, unknown> = {}) => ({
  tenantId: s.tenantId,
  runId: s.runId,
  toYearId: s.y2027,
  studentId: s.studentId,
  fromEnrolmentId: s.enrolmentId,
  fromSectionId: s.six26,
  fromRoll: 1,
  decision: 'PROMOTE' as const,
  targetClassLevelId: s.c7,
  targetSectionId: s.seven27,
  ...extra,
});

/** Run `fn` in a savepoint-free transaction and return the error it throws (or null). */
async function failure(app: PrismaClient, tenantId: string, fn: (tx: Tx) => Promise<unknown>) {
  try {
    await withTenant(app, tenantId, fn);
    return null;
  } catch (e) {
    return e as Error;
  }
}

describe('promotion tables: RLS, composite targets, pending-only edits (P5)', () => {
  let app: PrismaClient;
  let a: School;
  let b: School;

  beforeAll(async () => {
    app = appClient();
    a = await school(app);
    b = await school(app);
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it('isolates runs and rows per institute', async () => {
    await withTenant(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.create({ data: promoteRow(a) }),
    );
    const seen = await withTenant(app, b.tenantId, async (tx) => ({
      runs: await tx.promotionRun.findMany({ where: { id: a.runId } }),
      rows: await tx.promotionRunStudent.findMany({ where: { runId: a.runId } }),
    }));
    expect(seen).toEqual({ runs: [], rows: [] });
    const own = await withTenant(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.count({ where: { runId: a.runId } }),
    );
    expect(own).toBe(1);
    await withTenant(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.deleteMany({ where: { runId: a.runId } }),
    );
  });

  it("refuses another institute's student, section or run (composite foreign keys)", async () => {
    const otherStudent = await failure(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.create({ data: promoteRow(a, { studentId: b.studentId }) }),
    );
    expect(otherStudent?.message).toMatch(/foreign key/i);
    const otherSection = await failure(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.create({ data: promoteRow(a, { targetSectionId: b.seven27 }) }),
    );
    expect(otherSection?.message).toMatch(/foreign key/i);
    const otherRun = await failure(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.create({ data: promoteRow(a, { runId: b.runId }) }),
    );
    expect(otherRun?.message).toMatch(/foreign key/i);
  });

  it('refuses a target section of another year or another class', async () => {
    const otherYear = await failure(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.create({ data: promoteRow(a, { targetSectionId: a.seven26 }) }),
    );
    expect(otherYear?.message).toMatch(/foreign key/i);
    const otherClass = await failure(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.create({ data: promoteRow(a, { targetSectionId: a.six27 }) }),
    );
    expect(otherClass?.message).toMatch(/foreign key/i);
    // A row whose to-year is not its run's.
    const otherToYear = await failure(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.create({
        data: promoteRow(a, { toYearId: a.y2026, targetSectionId: null }),
      }),
    );
    expect(otherToYear?.message).toMatch(/foreign key/i);
  });

  it('refuses a merit exam of another year', async () => {
    const err = await failure(app, a.tenantId, (tx) =>
      tx.promotionRun.create({
        data: {
          tenantId: a.tenantId,
          fromYearId: a.y2026,
          toYearId: a.y2027,
          classLevelId: a.c7,
          rollStrategy: 'MERIT',
          meritExamId: a.exam27,
          createdById: a.adminId,
        },
      }),
    );
    expect(err?.message).toMatch(/foreign key/i);
    // The from-year's exam is fine.
    const ok = await withTenant(app, a.tenantId, (tx) =>
      tx.promotionRun.create({
        data: {
          tenantId: a.tenantId,
          fromYearId: a.y2026,
          toYearId: a.y2027,
          classLevelId: a.c7,
          rollStrategy: 'MERIT',
          meritExamId: a.exam26,
          createdById: a.adminId,
        },
        select: { id: true },
      }),
    );
    expect(ok.id).toBeTruthy();
  });

  it('checks the run: years differ, MERIT needs an exam, applied and started fields', async () => {
    const base = {
      tenantId: a.tenantId,
      fromYearId: a.y2026,
      toYearId: a.y2027,
      createdById: a.adminId,
      rollStrategy: 'NAME_BN' as const,
    };
    const c8 = await withTenant(app, a.tenantId, (tx) =>
      tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_8' } }),
    );
    for (const data of [
      { ...base, classLevelId: c8.id, toYearId: a.y2026 },
      { ...base, classLevelId: c8.id, rollStrategy: 'MERIT' as const },
      { ...base, classLevelId: c8.id, status: 'APPLIED' as const },
      { ...base, classLevelId: c8.id, status: 'APPLYING' as const },
      { ...base, classLevelId: c8.id, lastError: 'a message, not a code' },
    ]) {
      const err = await failure(app, a.tenantId, (tx) => tx.promotionRun.create({ data }));
      expect(err?.message).toMatch(/check constraint/i);
    }
  });

  it('checks the LEAVE and PROMOTE/REPEAT combinations', async () => {
    const forbidden = [
      // LEAVE needs a status and a date and no target.
      { decision: 'LEAVE', targetClassLevelId: null, targetSectionId: null },
      {
        decision: 'LEAVE',
        targetClassLevelId: null,
        targetSectionId: null,
        leaveStatus: 'GRADUATED',
      },
      {
        decision: 'LEAVE',
        targetSectionId: null,
        leaveStatus: 'GRADUATED',
        leftOn: new Date('2026-12-31'),
      },
      // ACTIVE is not a way of leaving.
      {
        decision: 'LEAVE',
        targetClassLevelId: null,
        targetSectionId: null,
        leaveStatus: 'ACTIVE',
        leftOn: new Date('2026-12-31'),
      },
      // PROMOTE needs a class and no leaving fields.
      { decision: 'PROMOTE', targetClassLevelId: null, targetSectionId: null },
      { decision: 'REPEAT', targetClassLevelId: a.c6, targetSectionId: null, leftOn: new Date() },
      // An outcome only with applied_at, an enrolment only with an enrolling outcome.
      { appliedAt: new Date() },
      { applyOutcome: 'ENROLLED', appliedAt: new Date() },
      { toEnrolmentId: a.enrolmentId },
      { leaveReason: 'x'.repeat(501) },
    ];
    for (const extra of forbidden) {
      const err = await failure(app, a.tenantId, (tx) =>
        tx.promotionRunStudent.create({ data: promoteRow(a, extra) }),
      );
      expect(err?.message, JSON.stringify(extra)).toMatch(/check constraint/i);
    }
    // A valid leaver.
    const ok = await withTenant(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.create({
        data: promoteRow(a, {
          decision: 'LEAVE',
          targetClassLevelId: null,
          targetSectionId: null,
          leaveStatus: 'GRADUATED',
          leftOn: new Date('2026-12-31'),
          leaveReason: 'SSC',
        }),
        select: { id: true },
      }),
    );
    await withTenant(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.delete({ where: { id: ok.id } }),
    );
  });

  it('edits and deletes pending rows only; applying a pending row still works', async () => {
    const row = await withTenant(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.create({ data: promoteRow(a), select: { id: true } }),
    );
    // Pending: may be edited.
    const edited = await withTenant(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.updateMany({
        where: { id: row.id },
        data: { decision: 'REPEAT', targetClassLevelId: a.c6, targetSectionId: a.six27 },
      }),
    );
    expect(edited.count).toBe(1);
    // Apply it (a pending row gets applied_at).
    const toEnrolment = await withTenant(app, a.tenantId, (tx) =>
      tx.enrolment.create({
        data: {
          tenantId: a.tenantId,
          studentId: a.studentId,
          academicYearId: a.y2027,
          classLevelId: a.c6,
          sectionId: a.six27,
        },
        select: { id: true },
      }),
    );
    const applied = await withTenant(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.updateMany({
        where: { id: row.id },
        data: { appliedAt: new Date(), applyOutcome: 'ENROLLED', toEnrolmentId: toEnrolment.id },
      }),
    );
    expect(applied.count).toBe(1);
    // Applied: neither updated nor deleted.
    const after = await withTenant(app, a.tenantId, async (tx) => ({
      updated: (
        await tx.promotionRunStudent.updateMany({
          where: { id: row.id },
          data: { decision: 'PROMOTE', targetClassLevelId: a.c7, targetSectionId: a.seven27 },
        })
      ).count,
      deleted: (await tx.promotionRunStudent.deleteMany({ where: { id: row.id } })).count,
      row: await tx.promotionRunStudent.findUniqueOrThrow({ where: { id: row.id } }),
    }));
    expect(after.updated).toBe(0);
    expect(after.deleted).toBe(0);
    expect(after.row).toMatchObject({ decision: 'REPEAT', applyOutcome: 'ENROLLED' });
  });

  it('a run with an applied row is never deleted; one without may be (review SF6)', async () => {
    // a's run has an applied row (the test above): the restrictive policy keeps it.
    const kept = await withTenant(
      app,
      a.tenantId,
      (tx) => tx.$executeRaw`DELETE FROM promotion_runs WHERE id = ${a.runId}::uuid`,
    );
    expect(kept).toBe(0);
    // An empty draft goes.
    const draft = await withTenant(app, a.tenantId, async (tx) =>
      tx.promotionRun.create({
        data: {
          tenantId: a.tenantId,
          fromYearId: a.y2026,
          toYearId: a.y2027,
          classLevelId: (await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_10' } })).id,
          rollStrategy: 'NAME_BN',
          createdById: a.adminId,
        },
        select: { id: true },
      }),
    );
    const gone = await withTenant(
      app,
      a.tenantId,
      (tx) => tx.$executeRaw`DELETE FROM promotion_runs WHERE id = ${draft.id}::uuid`,
    );
    expect(gone).toBe(1);
  });

  it("a row's enrolments are its own student's, the new one in its run's to-year", async () => {
    const other = await withTenant(app, a.tenantId, async (tx) => {
      const st = await tx.student.create({
        data: { tenantId: a.tenantId, studentCode: `O-${randomUUID().slice(0, 8)}`, nameEn: 'O' },
      });
      const e26 = await tx.enrolment.create({
        data: {
          tenantId: a.tenantId,
          studentId: st.id,
          academicYearId: a.y2026,
          classLevelId: a.c6,
        },
      });
      return { studentId: st.id, e26: e26.id };
    });
    const run8 = await withTenant(app, a.tenantId, async (tx) =>
      tx.promotionRun.create({
        data: {
          tenantId: a.tenantId,
          fromYearId: a.y2026,
          toYearId: a.y2027,
          classLevelId: (await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_9' } })).id,
          rollStrategy: 'NAME_BN',
          createdById: a.adminId,
        },
        select: { id: true },
      }),
    );
    // Someone else's enrolment as the from-enrolment.
    const wrongFrom = await failure(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.create({
        data: promoteRow(a, { runId: run8.id, studentId: other.studentId }),
      }),
    );
    expect(wrongFrom?.message).toMatch(/foreign key/i);
    // A new enrolment of the old year (not the run's to-year).
    const wrongTo = await failure(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.create({
        data: promoteRow(a, {
          runId: run8.id,
          studentId: other.studentId,
          fromEnrolmentId: other.e26,
          appliedAt: new Date(),
          applyOutcome: 'ENROLLED',
          toEnrolmentId: other.e26,
        }),
      }),
    );
    expect(wrongTo?.message).toMatch(/foreign key/i);
  });

  it('the app cannot change a run’s years or class, or a row’s student', async () => {
    for (const col of ['from_year_id', 'to_year_id', 'class_level_id', 'created_by_id']) {
      const err = await failure(app, a.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE promotion_runs SET ${col} = ${col} WHERE id = $1::uuid`,
          a.runId,
        ),
      );
      expect(err?.message, col).toMatch(/permission denied/i);
    }
    for (const col of ['student_id', 'run_id', 'to_year_id', 'from_enrolment_id', 'from_roll']) {
      const err = await failure(app, a.tenantId, (tx) =>
        tx.$executeRawUnsafe(`UPDATE promotion_run_students SET ${col} = ${col}`),
      );
      expect(err?.message, col).toMatch(/permission denied/i);
    }
  });

  it('one run per from-year, to-year and class; a student in one run into a year', async () => {
    const dupRun = await failure(app, b.tenantId, (tx) =>
      tx.promotionRun.create({
        data: {
          tenantId: b.tenantId,
          fromYearId: b.y2026,
          toYearId: b.y2027,
          classLevelId: b.c6,
          rollStrategy: 'KEEP',
          createdById: b.adminId,
        },
      }),
    );
    expect(dupRun?.message).toMatch(/unique constraint/i);
    // A second run (class 7 → 2027) cannot take b's student into 2027 again.
    await withTenant(app, b.tenantId, async (tx) => {
      await tx.promotionRunStudent.create({ data: promoteRow(b) });
    });
    const run7 = await withTenant(app, b.tenantId, (tx) =>
      tx.promotionRun.create({
        data: {
          tenantId: b.tenantId,
          fromYearId: b.y2026,
          toYearId: b.y2027,
          classLevelId: b.c7,
          rollStrategy: 'KEEP',
          createdById: b.adminId,
        },
        select: { id: true },
      }),
    );
    const dupStudent = await failure(app, b.tenantId, (tx) =>
      tx.promotionRunStudent.create({ data: promoteRow(b, { runId: run7.id }) }),
    );
    expect(dupStudent?.message).toMatch(/unique constraint/i);
  });
});

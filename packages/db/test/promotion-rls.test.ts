import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone, yearRange } from './helpers.js';

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/**
 * A school with this year (the test year, current) and the next, class 6 and 7 sections in both
 * years, a student in class 6 ক of this year, an exam of each year, and a draft run of class 6
 * into the next year.
 */
async function school(app: PrismaClient) {
  const tenant = await createTenant(app);
  const tenantId = tenant.id;
  return withTenant(app, tenantId, async (tx) => {
    const thisYear = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const nextYear = await tx.academicYear.create({
      data: { tenantId, ...yearRange(thisYear.startDate.getUTCFullYear() + 1) },
    });
    const c6 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_6' } });
    const c7 = await tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_7' } });
    const section = (academicYearId: string, classLevelId: string, name = 'ক') =>
      tx.section.create({ data: { tenantId, academicYearId, classLevelId, name } });
    const sixThisYear = await section(thisYear.id, c6.id);
    const sevenNextYear = await section(nextYear.id, c7.id);
    const sixNextYear = await section(nextYear.id, c6.id);
    const sevenThisYear = await section(thisYear.id, c7.id);
    const adminId = await findOrCreateUser(tx, randomPhone(), 'Admin');
    await tx.membership.create({ data: { tenantId, userId: adminId, role: 'ADMIN' } });
    const student = await tx.student.create({
      data: { tenantId, studentCode: `P-${randomUUID().slice(0, 8)}`, nameEn: 'Promo' },
    });
    const enrolment = await tx.enrolment.create({
      data: {
        tenantId,
        studentId: student.id,
        academicYearId: thisYear.id,
        classLevelId: c6.id,
        sectionId: sixThisYear.id,
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
    const examThisYear = await exam(thisYear.id);
    const examNextYear = await exam(nextYear.id);
    const run = await tx.promotionRun.create({
      data: {
        tenantId,
        fromYearId: thisYear.id,
        toYearId: nextYear.id,
        classLevelId: c6.id,
        rollStrategy: 'NAME_BN',
        createdById: adminId,
      },
    });
    return {
      tenantId,
      thisYear: thisYear.id,
      nextYear: nextYear.id,
      c6: c6.id,
      c7: c7.id,
      sixThisYear: sixThisYear.id,
      sixNextYear: sixNextYear.id,
      sevenThisYear: sevenThisYear.id,
      sevenNextYear: sevenNextYear.id,
      adminId,
      studentId: student.id,
      enrolmentId: enrolment.id,
      examThisYear: examThisYear.id,
      examNextYear: examNextYear.id,
      runId: run.id,
    };
  });
}

type School = Awaited<ReturnType<typeof school>>;

const promoteRow = (s: School, extra: Record<string, unknown> = {}) => ({
  tenantId: s.tenantId,
  runId: s.runId,
  toYearId: s.nextYear,
  studentId: s.studentId,
  fromEnrolmentId: s.enrolmentId,
  fromSectionId: s.sixThisYear,
  fromRoll: 1,
  decision: 'PROMOTE' as const,
  targetClassLevelId: s.c7,
  targetSectionId: s.sevenNextYear,
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
      tx.promotionRunStudent.create({ data: promoteRow(a, { targetSectionId: b.sevenNextYear }) }),
    );
    expect(otherSection?.message).toMatch(/foreign key/i);
    const otherRun = await failure(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.create({ data: promoteRow(a, { runId: b.runId }) }),
    );
    expect(otherRun?.message).toMatch(/foreign key/i);
  });

  it('refuses a target section of another year or another class', async () => {
    const otherYear = await failure(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.create({ data: promoteRow(a, { targetSectionId: a.sevenThisYear }) }),
    );
    expect(otherYear?.message).toMatch(/foreign key/i);
    const otherClass = await failure(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.create({ data: promoteRow(a, { targetSectionId: a.sixNextYear }) }),
    );
    expect(otherClass?.message).toMatch(/foreign key/i);
    // A row whose to-year is not its run's.
    const otherToYear = await failure(app, a.tenantId, (tx) =>
      tx.promotionRunStudent.create({
        data: promoteRow(a, { toYearId: a.thisYear, targetSectionId: null }),
      }),
    );
    expect(otherToYear?.message).toMatch(/foreign key/i);
  });

  it('refuses a merit exam of another year', async () => {
    const err = await failure(app, a.tenantId, (tx) =>
      tx.promotionRun.create({
        data: {
          tenantId: a.tenantId,
          fromYearId: a.thisYear,
          toYearId: a.nextYear,
          classLevelId: a.c7,
          rollStrategy: 'MERIT',
          meritExamId: a.examNextYear,
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
          fromYearId: a.thisYear,
          toYearId: a.nextYear,
          classLevelId: a.c7,
          rollStrategy: 'MERIT',
          meritExamId: a.examThisYear,
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
      fromYearId: a.thisYear,
      toYearId: a.nextYear,
      createdById: a.adminId,
      rollStrategy: 'NAME_BN' as const,
    };
    const c8 = await withTenant(app, a.tenantId, (tx) =>
      tx.classLevel.findFirstOrThrow({ where: { code: 'CLASS_8' } }),
    );
    for (const data of [
      { ...base, classLevelId: c8.id, toYearId: a.thisYear },
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
        data: { decision: 'REPEAT', targetClassLevelId: a.c6, targetSectionId: a.sixNextYear },
      }),
    );
    expect(edited.count).toBe(1);
    // Apply it (a pending row gets applied_at).
    const toEnrolment = await withTenant(app, a.tenantId, (tx) =>
      tx.enrolment.create({
        data: {
          tenantId: a.tenantId,
          studentId: a.studentId,
          academicYearId: a.nextYear,
          classLevelId: a.c6,
          sectionId: a.sixNextYear,
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
          data: { decision: 'PROMOTE', targetClassLevelId: a.c7, targetSectionId: a.sevenNextYear },
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
          fromYearId: a.thisYear,
          toYearId: a.nextYear,
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
          academicYearId: a.thisYear,
          classLevelId: a.c6,
        },
      });
      return { studentId: st.id, e26: e26.id };
    });
    const run8 = await withTenant(app, a.tenantId, async (tx) =>
      tx.promotionRun.create({
        data: {
          tenantId: a.tenantId,
          fromYearId: a.thisYear,
          toYearId: a.nextYear,
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
          fromYearId: b.thisYear,
          toYearId: b.nextYear,
          classLevelId: b.c6,
          rollStrategy: 'KEEP',
          createdById: b.adminId,
        },
      }),
    );
    expect(dupRun?.message).toMatch(/unique constraint/i);
    // A second run (class 7 → next year) cannot take b's student into next year again.
    await withTenant(app, b.tenantId, async (tx) => {
      await tx.promotionRunStudent.create({ data: promoteRow(b) });
    });
    const run7 = await withTenant(app, b.tenantId, (tx) =>
      tx.promotionRun.create({
        data: {
          tenantId: b.tenantId,
          fromYearId: b.thisYear,
          toYearId: b.nextYear,
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

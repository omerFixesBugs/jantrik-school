import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import {
  dateFromDb,
  dateToDb,
  parseMarks,
  type AdmissionAdmitCards,
  type AdmissionScoreRow,
  type AdmissionTestClassView,
  type AdmissionTestSetup,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { Clock } from '../common/clock.js';
import { Db } from '../tenancy/db.service.js';

const NAMED = { id: true, nameBn: true, nameEn: true } as const;

/** "HH:MM" ↔ the TIME column (Prisma reads it as a date on 1970-01-01, UTC). */
const timeToDb = (hhmm: string | null) => (hhmm ? new Date(`1970-01-01T${hhmm}:00.000Z`) : null);
const timeFromDb = (d: Date | null) => (d ? d.toISOString().slice(11, 16) : null);

/** An application number's order: year, then the number (they are not zero-padded alike). */
const byApplicationNo = (a: string, b: string) => {
  const [ya, na] = a.split('-').map(Number) as [number, number];
  const [yb, nb] = b.split('-').map(Number) as [number, number];
  return ya - yb || na - nb;
};

export type LockedTestClass = Awaited<ReturnType<AdmissionTestService['lockClass']>>;

/**
 * The admission test of a class (sprint 1 P4, docs/admission.md → "The admission test"): its
 * settings, the test rolls (decision P4-C), the admit cards (P4-K) and the scores (S12, one total
 * per applicant, hundredths, audited: CLAUDE.md rule 6). OWNER/ADMIN only (P4-L).
 */
@Injectable()
export class AdmissionTestService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * The class row, locked for this transaction, after the cycle's lock taken shared: every test
   * operation on one class runs one at a time, and a cycle edit (exclusive) waits for them (the
   * same key and order as P3's applications).
   */
  async lockClass(id: string) {
    const tx = this.db.tx;
    const ref = await tx.admissionCycleClass.findUnique({
      where: { id },
      select: { cycleId: true },
    });
    if (!ref) throw new NotFoundException('Admission class not found');
    const key = `admission-cycle:${ref.cycleId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`;
    await tx.$queryRaw`SELECT id FROM public.admission_cycle_classes WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.admissionCycleClass.findUnique({
      where: { id },
      include: { cycle: { select: { id: true, requiresTest: true, meritTieBreak: true } } },
    });
    if (!row) throw new NotFoundException('Admission class not found');
    return row;
  }

  /** 422 unless the class's cycle has an admission test. */
  requireTest(row: { cycle: { requiresTest: boolean } }): void {
    if (!row.cycle.requiresTest) {
      throw apiError(422, 'TEST_NOT_REQUIRED', 'This cycle has no admission test');
    }
  }

  async view(id: string): Promise<AdmissionTestClassView> {
    const tx = this.db.tx;
    const row = await tx.admissionCycleClass.findUnique({
      where: { id },
      include: {
        cycle: {
          select: { id: true, nameBn: true, nameEn: true, requiresTest: true, meritTieBreak: true },
        },
        classLevel: { select: NAMED },
        studyGroup: { select: NAMED },
      },
    });
    if (!row) throw new NotFoundException('Admission class not found');
    const where = { cycleClassId: id };
    const [withRoll, awaitingRoll, scored, absent] = await Promise.all([
      tx.admissionApplication.count({ where: { ...where, testRoll: { not: null } } }),
      tx.admissionApplication.count({
        where: { ...where, testRoll: null, status: { in: ['SUBMITTED', 'SHORTLISTED'] } },
      }),
      tx.admissionApplication.count({ where: { ...where, testScoreH: { not: null } } }),
      tx.admissionApplication.count({ where: { ...where, testAbsent: true } }),
    ]);
    return {
      id: row.id,
      cycle: row.cycle,
      classLevel: row.classLevel,
      studyGroup: row.studyGroup,
      testDate: row.testDate ? dateFromDb(row.testDate) : null,
      testTime: timeFromDb(row.testTime),
      testVenueBn: row.testVenueBn,
      testVenueEn: row.testVenueEn,
      fullMarks: row.fullMarks,
      passMarks: row.passMarks,
      selectCount: row.selectCount,
      waitlistCount: row.waitlistCount,
      meritBuiltAt: row.meritBuiltAt?.toISOString() ?? null,
      resultsVersion: row.resultsVersion,
      resultsPublishedAt: row.resultsPublishedAt?.toISOString() ?? null,
      changedSincePublish:
        !!row.resultsPublishedAt &&
        !!row.scoresChangedAt &&
        row.scoresChangedAt > row.resultsPublishedAt,
      counts: { withRoll, awaitingRoll, scored, absent },
    };
  }

  /** PATCH …/test: the date, time, venue, full and pass marks, select and waitlist counts. */
  async setup(id: string, input: AdmissionTestSetup): Promise<AdmissionTestClassView> {
    const tx = this.db.tx;
    const old = await this.lockClass(id);
    this.requireTest(old);
    const before = {
      testDate: old.testDate ? dateFromDb(old.testDate) : null,
      testTime: timeFromDb(old.testTime),
      testVenueBn: old.testVenueBn,
      testVenueEn: old.testVenueEn,
      fullMarks: old.fullMarks,
      passMarks: old.passMarks,
      selectCount: old.selectCount,
      waitlistCount: old.waitlistCount,
    };
    const changed: Record<string, unknown> = {};
    const was: Record<string, unknown> = {};
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      const value = input[key];
      if (value === undefined || value === before[key]) continue;
      changed[key] = value;
      was[key] = before[key];
    }
    if (Object.keys(changed).length === 0) return this.view(id);
    const full = 'fullMarks' in changed ? (changed['fullMarks'] as number | null) : old.fullMarks;
    const pass = 'passMarks' in changed ? (changed['passMarks'] as number | null) : old.passMarks;
    if (pass !== null && (full === null || pass > full)) {
      throw apiError(422, 'PASS_ABOVE_FULL', 'The pass marks must be within the full marks', {
        field: 'passMarks',
      });
    }
    if ('fullMarks' in changed) {
      const above = await tx.admissionApplication.count({
        where: {
          cycleClassId: id,
          testScoreH: full === null ? { not: null } : { gt: full * 100 },
        },
      });
      if (above > 0) {
        throw apiError(409, 'SCORES_ABOVE_FULL', 'Some scores are above these full marks', {
          field: 'fullMarks',
          count: above,
        });
      }
    }
    const data: Prisma.AdmissionCycleClassUncheckedUpdateInput = {};
    if ('testDate' in changed) {
      data.testDate = changed['testDate'] ? dateToDb(changed['testDate'] as string) : null;
    }
    if ('testTime' in changed) data.testTime = timeToDb(changed['testTime'] as string | null);
    for (const key of [
      'testVenueBn',
      'testVenueEn',
      'fullMarks',
      'passMarks',
      'selectCount',
      'waitlistCount',
    ] as const) {
      if (key in changed) (data as Record<string, unknown>)[key] = changed[key];
    }
    await tx.admissionCycleClass.update({ where: { id }, data, select: { id: true } });
    await this.audit.record({
      entity: 'admission_test_setup',
      entityId: id,
      action: 'UPDATE',
      oldValues: was as Prisma.InputJsonValue,
      newValues: changed as Prisma.InputJsonValue,
    });
    return this.view(id);
  }

  /**
   * POST …/test-rolls (decision P4-C): SUBMITTED and SHORTLISTED applications without a roll, by
   * application number, numbered on from the last roll issued (or `startAt`, 1 by default, for the
   * first ones). An issued roll is never renumbered.
   */
  async issueRolls(
    id: string,
    startAt: number | null | undefined,
  ): Promise<{ issued: number; from: number | null; to: number | null }> {
    const tx = this.db.tx;
    const cls = await this.lockClass(id);
    this.requireTest(cls);
    const [last, waiting] = await Promise.all([
      tx.admissionApplication.aggregate({ where: { cycleClassId: id }, _max: { testRoll: true } }),
      tx.admissionApplication.findMany({
        where: { cycleClassId: id, testRoll: null, status: { in: ['SUBMITTED', 'SHORTLISTED'] } },
        select: { id: true, applicationNo: true },
      }),
    ]);
    if (waiting.length === 0) return { issued: 0, from: null, to: null };
    waiting.sort((a, b) => byApplicationNo(a.applicationNo, b.applicationNo));
    const from = last._max.testRoll !== null ? last._max.testRoll + 1 : (startAt ?? 1);
    const to = from + waiting.length - 1;
    if (to > 999_999) throw apiError(422, 'ROLLS_EXHAUSTED', 'Test rolls go up to 999999');
    const ids = waiting.map((w) => w.id);
    const rolls = waiting.map((_, i) => from + i);
    await tx.$executeRaw`
      UPDATE public.admission_applications a
         SET test_roll = v.roll, updated_at = now()
        FROM unnest(${ids}::uuid[], ${rolls}::int[]) AS v(id, roll)
       WHERE a.id = v.id AND a.test_roll IS NULL`;
    await this.audit.record({
      entity: 'admission_test_rolls',
      entityId: id,
      action: 'UPDATE',
      newValues: { from, to, applicationIds: ids },
    });
    return { issued: waiting.length, from, to };
  }

  /** GET …/admit-cards: the issued rolls (a roll range), with the institute's header. */
  async admitCards(id: string, from?: number, to?: number): Promise<AdmissionAdmitCards> {
    const tx = this.db.tx;
    const cls = await tx.admissionCycleClass.findUnique({
      where: { id },
      include: {
        cycle: { select: { nameBn: true, nameEn: true, requiresTest: true } },
        classLevel: { select: NAMED },
        studyGroup: { select: NAMED },
      },
    });
    if (!cls) throw new NotFoundException('Admission class not found');
    this.requireTest(cls);
    const issued = await tx.admissionApplication.count({
      where: { cycleClassId: id, testRoll: { not: null } },
    });
    if (issued === 0) throw apiError(422, 'ROLLS_NOT_ISSUED', 'Issue the test rolls first');
    const [tenant, profile, rows] = await Promise.all([
      tx.tenant.findFirstOrThrow({ select: { name: true } }),
      tx.instituteProfile.findFirst({
        select: { nameBn: true, nameEn: true, logoFileId: true },
      }),
      tx.admissionApplication.findMany({
        where: {
          cycleClassId: id,
          testRoll: { not: null, ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) },
        },
        orderBy: { testRoll: 'asc' },
        select: {
          id: true,
          applicationNo: true,
          testRoll: true,
          nameBn: true,
          nameEn: true,
          photo: { select: { applicationId: true } },
        },
      }),
    ]);
    return {
      institute: {
        name: tenant.name,
        nameBn: profile?.nameBn ?? null,
        nameEn: profile?.nameEn ?? null,
        hasLogo: !!profile?.logoFileId,
      },
      cycle: { nameBn: cls.cycle.nameBn, nameEn: cls.cycle.nameEn },
      classLevel: cls.classLevel,
      studyGroup: cls.studyGroup,
      testDate: cls.testDate ? dateFromDb(cls.testDate) : null,
      testTime: timeFromDb(cls.testTime),
      testVenueBn: cls.testVenueBn,
      testVenueEn: cls.testVenueEn,
      cards: rows.map((r) => ({
        applicationId: r.id,
        applicationNo: r.applicationNo,
        testRoll: r.testRoll!,
        nameBn: r.nameBn,
        nameEn: r.nameEn,
        hasPhoto: !!r.photo,
      })),
    };
  }

  /** GET …/scores: the grid, by roll. */
  async scores(id: string): Promise<AdmissionScoreRow[]> {
    const cls = await this.db.tx.admissionCycleClass.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!cls) throw new NotFoundException('Admission class not found');
    const rows = await this.db.tx.admissionApplication.findMany({
      where: { cycleClassId: id, testRoll: { not: null } },
      orderBy: { testRoll: 'asc' },
      select: {
        id: true,
        applicationNo: true,
        testRoll: true,
        nameBn: true,
        nameEn: true,
        testScoreH: true,
        testAbsent: true,
        status: true,
      },
    });
    return rows.map((r) => ({
      applicationId: r.id,
      applicationNo: r.applicationNo,
      testRoll: r.testRoll!,
      nameBn: r.nameBn,
      nameEn: r.nameEn,
      scoreH: r.testScoreH,
      absent: r.testAbsent,
      status: r.status,
    }));
  }

  /**
   * PUT …/scores: up to 500 rows, all checked before any is saved (one transaction). A score as
   * typed (Bangla digits, two decimals at most, within the full marks; `a`/`অ` is absent), or
   * absent. Every change is audited with its old and new values (rule 6).
   */
  async saveScores(
    id: string,
    input: { applicationId: string; score: string | null; absent: boolean }[],
  ): Promise<AdmissionScoreRow[]> {
    const tx = this.db.tx;
    const cls = await this.lockClass(id);
    this.requireTest(cls);
    if (cls.fullMarks === null) {
      throw apiError(422, 'TEST_NOT_CONFIGURED', 'Set the full marks first', {
        field: 'fullMarks',
      });
    }
    const found = await tx.admissionApplication.findMany({
      where: { id: { in: input.map((r) => r.applicationId) }, cycleClassId: id },
      select: { id: true, testRoll: true, testScoreH: true, testAbsent: true },
    });
    const byId = new Map(found.map((r) => [r.id, r]));
    const next: { id: string; scoreH: number | null; absent: boolean }[] = [];
    for (const r of input) {
      const app = byId.get(r.applicationId);
      if (!app) throw new NotFoundException('Application not found in this class');
      if (app.testRoll === null) {
        throw apiError(422, 'NO_ROLL', 'This applicant has no test roll', {
          applicationId: r.applicationId,
        });
      }
      const parsed = parseMarks(r.score ?? '', cls.fullMarks);
      let scoreH: number | null = null;
      let absent = r.absent;
      if (parsed.kind === 'absent') absent = true;
      else if (parsed.kind === 'marks') {
        if (r.absent) {
          throw apiError(422, 'SCORE_AND_ABSENT', 'An absent applicant has no score', {
            applicationId: r.applicationId,
          });
        }
        scoreH = parsed.hundredths;
      } else if (parsed.kind === 'invalid') {
        throw apiError(
          422,
          parsed.reason === 'OVER_FULL' ? 'SCORE_OUT_OF_RANGE' : 'SCORE_INVALID',
          parsed.reason === 'OVER_FULL' ? 'The score is above the full marks' : 'Not a score',
          { applicationId: r.applicationId },
        );
      }
      if (scoreH === app.testScoreH && absent === app.testAbsent) continue;
      next.push({ id: r.applicationId, scoreH, absent });
    }
    for (const n of next) {
      const old = byId.get(n.id)!;
      await tx.admissionApplication.update({
        where: { id: n.id },
        data: { testScoreH: n.scoreH, testAbsent: n.absent },
        select: { id: true },
      });
      await this.audit.record({
        entity: 'admission_test_score',
        entityId: n.id,
        action: 'UPDATE',
        oldValues: { scoreH: old.testScoreH, absent: old.testAbsent },
        newValues: { scoreH: n.scoreH, absent: n.absent },
      });
    }
    if (next.length > 0) {
      await tx.admissionCycleClass.update({
        where: { id },
        data: { scoresChangedAt: this.clock.now() },
        select: { id: true },
      });
    }
    return this.scores(id);
  }
}

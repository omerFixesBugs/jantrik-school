import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import {
  ADMISSION_TEST_REJECT_REASONS,
  ADMISSION_TEST_RESULTS,
  admissionMerit,
  dateFromDb,
  type AdmissionApplicationStatus,
  type AdmissionMeritRow,
  type AdmissionMeritView,
  type AdmissionMoveUpResult,
  type AdmissionTestResult,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../common/request-context.js';
import { Db } from '../tenancy/db.service.js';
import { AdmissionTestService, type LockedTestClass } from './test.service.js';

/** The statuses whose holders take part in the merit list (they have a roll). */
const RANKED: readonly AdmissionApplicationStatus[] = [
  'SUBMITTED',
  'SHORTLISTED',
  'SELECTED',
  'WAITLISTED',
  'ADMITTED',
];
const REJECT_REASONS: readonly string[] = ADMISSION_TEST_REJECT_REASONS;

const ROW_SELECT = {
  id: true,
  applicationNo: true,
  testRoll: true,
  nameBn: true,
  nameEn: true,
  dateOfBirth: true,
  submittedAt: true,
  status: true,
  statusReason: true,
  testScoreH: true,
  testAbsent: true,
  testResult: true,
  meritPosition: true,
  waitlistPosition: true,
  resultVersion: true,
  resultMeritPosition: true,
  resultWaitlistPosition: true,
  resultFlag: true,
} satisfies Prisma.AdmissionApplicationSelect;
type Row = Prisma.AdmissionApplicationGetPayload<{ select: typeof ROW_SELECT }>;

/**
 * In the merit list: a roll, and a status that takes part (decision P4-E), or REJECTED by an
 * earlier publish (a correction may move them up). Withdrawn applicants and those rejected by
 * staff for another reason are left out.
 */
const ranked = (r: Row) =>
  r.testRoll !== null &&
  (RANKED.includes(r.status) ||
    (r.status === 'REJECTED' &&
      r.resultVersion !== null &&
      REJECT_REASONS.includes(r.statusReason ?? '')));

/** What a publish turns a draft outcome into (P4-E). */
const publishedStatus = (result: AdmissionTestResult) =>
  result === 'SELECTED' ? 'SELECTED' : result === 'WAITLISTED' ? 'WAITLISTED' : 'REJECTED';

/**
 * The merit list of a class (sprint 1 P4): build a draft (no status changes), publish it
 * (statuses, version + 1, the published snapshot), and move the waitlist up. Every step holds the
 * class's lock (AdmissionTestService.lockClass).
 */
@Injectable()
export class AdmissionMeritService {
  constructor(
    private readonly db: Db,
    private readonly test: AdmissionTestService,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
  ) {}

  private async rows(cycleClassId: string): Promise<Row[]> {
    return this.db.tx.admissionApplication.findMany({
      where: { cycleClassId, testRoll: { not: null } },
      select: ROW_SELECT,
    });
  }

  /**
   * A hash of everything a build reads (P4-a3): the settings, the tie-break, and each ranked
   * applicant's score, absence, date of birth and submission time. Any change, even one that moves
   * no place, makes a build stale.
   */
  private inputsHash(cls: LockedTestClass, rows: Row[]): string {
    const input = {
      tieBreak: cls.cycle.meritTieBreak,
      passMarks: cls.passMarks,
      selectCount: cls.selectCount,
      waitlistCount: cls.waitlistCount,
      rows: rows
        .filter(ranked)
        .map((r) => [
          r.id,
          r.testScoreH,
          r.testAbsent,
          dateFromDb(r.dateOfBirth),
          r.submittedAt.toISOString(),
        ])
        .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    };
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
  }

  /** GET …/merit: the draft (and each row's published snapshot). */
  async view(id: string): Promise<AdmissionMeritView> {
    const cls = await this.db.tx.admissionCycleClass.findUnique({
      where: { id },
      include: { cycle: { select: { id: true, requiresTest: true, meritTieBreak: true } } },
    });
    if (!cls) throw apiError(404, 'NOT_FOUND', 'Admission class not found');
    const rows = await this.rows(id);
    const counts = Object.fromEntries(ADMISSION_TEST_RESULTS.map((r) => [r, 0])) as Record<
      AdmissionTestResult,
      number
    >;
    // Only applicants still in the list: a withdrawal shows at once, before a rebuild (N5).
    for (const r of rows) if (r.testResult && ranked(r)) counts[r.testResult]++;
    const out: AdmissionMeritRow[] = rows
      .map((r) =>
        ranked(r) ? r : { ...r, testResult: null, meritPosition: null, waitlistPosition: null },
      )
      .map((r) => ({
        applicationId: r.id,
        applicationNo: r.applicationNo,
        testRoll: r.testRoll!,
        nameBn: r.nameBn,
        nameEn: r.nameEn,
        dateOfBirth: dateFromDb(r.dateOfBirth),
        scoreH: r.testScoreH,
        absent: r.testAbsent,
        status: r.status,
        testResult: r.testResult,
        meritPosition: r.meritPosition,
        waitlistPosition: r.waitlistPosition,
        resultFlag: r.resultFlag,
        published:
          r.resultVersion !== null
            ? {
                version: r.resultVersion,
                meritPosition: r.resultMeritPosition,
                waitlistPosition: r.resultWaitlistPosition,
              }
            : null,
      }))
      .sort(
        (a, b) =>
          (a.meritPosition ?? Number.MAX_SAFE_INTEGER) -
            (b.meritPosition ?? Number.MAX_SAFE_INTEGER) || a.testRoll - b.testRoll,
      );
    return {
      builtAt: cls.meritBuiltAt?.toISOString() ?? null,
      publishedBuiltAt: cls.resultsBuiltAt?.toISOString() ?? null,
      stale: !!cls.meritInputsHash && cls.meritInputsHash !== this.inputsHash(cls, rows),
      boundaryTie: Math.max(0, counts.SELECTED - (cls.selectCount ?? counts.SELECTED)),
      waitlistTie: Math.max(0, counts.WAITLISTED - (cls.waitlistCount ?? counts.WAITLISTED)),
      counts,
      rows: out,
    };
  }

  /**
   * POST …/merit: build the draft. Places, outcomes and waitlist positions are written on the
   * rows; no status changes (P4-E) and nothing reaches the applicant before a publish.
   */
  async build(id: string): Promise<AdmissionMeritView> {
    const tx = this.db.tx;
    const cls = await this.test.lockClass(id);
    this.test.requireTest(cls);
    if (cls.fullMarks === null || cls.selectCount === null) {
      throw apiError(422, 'TEST_NOT_CONFIGURED', 'Set the full marks and the seats first');
    }
    const rows = await this.rows(id);
    const inList = rows.filter(ranked);
    const missing = inList.filter((r) => r.testScoreH === null && !r.testAbsent).length;
    if (missing > 0) {
      throw apiError(422, 'SCORES_MISSING', 'Some applicants have neither a score nor absent', {
        count: missing,
      });
    }
    const { outcomes, boundaryTie, waitlistTie } = admissionMerit(
      inList.map((r) => ({
        id: r.id,
        scoreH: r.testScoreH,
        absent: r.testAbsent,
        dateOfBirth: dateFromDb(r.dateOfBirth),
        submittedAt: r.submittedAt.toISOString(),
      })),
      {
        tieBreak: cls.cycle.meritTieBreak,
        passMarksH: cls.passMarks === null ? null : cls.passMarks * 100,
        selectCount: cls.selectCount,
        waitlistCount: cls.waitlistCount ?? 0,
      },
    );
    const ids = inList.map((r) => r.id);
    const results = ids.map((i) => outcomes.get(i)!.result);
    const places = ids.map((i) => outcomes.get(i)!.meritPosition);
    const waits = ids.map((i) => outcomes.get(i)!.waitlistPosition);
    await tx.$executeRaw`
      UPDATE public.admission_applications a
         SET test_result = NULL, merit_position = NULL, waitlist_position = NULL,
             updated_at = now()
       WHERE a.cycle_class_id = ${id}::uuid AND a.test_roll IS NOT NULL
         AND NOT (a.id = ANY(${ids}::uuid[]))
         AND (a.test_result IS NOT NULL OR a.merit_position IS NOT NULL)`;
    if (ids.length > 0) {
      await tx.$executeRaw`
        UPDATE public.admission_applications a
           SET test_result = v.result::public.admission_test_result,
               merit_position = v.place, waitlist_position = v.wait, updated_at = now()
          FROM unnest(${ids}::uuid[], ${results}::text[], ${places}::int[], ${waits}::int[])
               AS v(id, result, place, wait)
         WHERE a.id = v.id`;
    }
    const builtAt = this.clock.now();
    await tx.admissionCycleClass.update({
      where: { id },
      data: { meritBuiltAt: builtAt, meritInputsHash: this.inputsHash(cls, rows) },
      select: { id: true },
    });
    await this.audit.record({
      entity: 'admission_merit_build',
      entityId: id,
      action: 'UPDATE',
      newValues: {
        builtAt: builtAt.toISOString(),
        applicants: ids.length,
        boundaryTie,
        waitlistTie,
      },
    });
    return this.view(id);
  }

  /**
   * POST …/publish {builtAt}: the draft the admin looked at, still matching every input (review
   * focus 5: 409 MERIT_STALE otherwise), becomes the result: statuses, version + 1 and the
   * published snapshot. An ADMITTED applicant keeps their status and is flagged when the list no
   * longer selects them (P4-F).
   */
  async publish(id: string, builtAt: string): Promise<AdmissionMeritView> {
    const tx = this.db.tx;
    const cls = await this.test.lockClass(id);
    this.test.requireTest(cls);
    if (!cls.meritBuiltAt || !cls.meritInputsHash) {
      throw apiError(409, 'MERIT_NOT_BUILT', 'Build the merit list first');
    }
    // The same build is published once (review S2): a second publish would only bump the
    // version and cancel the SMS of the first.
    if (cls.resultsBuiltAt && cls.resultsBuiltAt.getTime() === cls.meritBuiltAt.getTime()) {
      throw apiError(409, 'ALREADY_PUBLISHED', 'This list is already published');
    }
    // Every applicant with a roll locked (id order, as moveUp) before anything is read (review
    // M1): a withdrawal or an approval that committed while this waited is seen, makes the
    // inputs differ (409 MERIT_STALE) or is kept (an ADMITTED status), and nothing changes under
    // the publish. P3's status changes and approvals lock the same rows.
    await tx.$queryRaw`
      SELECT id FROM public.admission_applications
       WHERE cycle_class_id = ${id}::uuid AND test_roll IS NOT NULL
       ORDER BY id FOR NO KEY UPDATE`;
    const rows = await this.rows(id);
    if (
      Date.parse(builtAt) !== cls.meritBuiltAt.getTime() ||
      cls.meritInputsHash !== this.inputsHash(cls, rows)
    ) {
      throw apiError(409, 'MERIT_STALE', 'The list changed since it was built: build it again');
    }
    const version = cls.resultsVersion + 1;
    const now = this.clock.now();
    const actor = this.context.requirePrincipal().userId;
    const inList = rows.filter(ranked);
    const byOutcome: Record<string, string[]> = {};
    const flagged: string[] = [];
    const ids: string[] = [];
    const before: string[] = [];
    const statuses: string[] = [];
    const reasons: (string | null)[] = [];
    const flags: (string | null)[] = [];
    const changed: boolean[] = [];
    for (const r of inList) {
      const result = r.testResult!;
      (byOutcome[result] ??= []).push(r.id);
      let status: string = r.status;
      let reason = r.statusReason;
      let flag: string | null = null;
      if (r.status === 'ADMITTED') {
        if (result !== 'SELECTED') {
          flag = 'ADMITTED_NOT_SELECTED';
          flagged.push(r.id);
        }
      } else {
        status = publishedStatus(result);
        reason = status === 'REJECTED' ? result : null;
      }
      ids.push(r.id);
      before.push(r.status);
      statuses.push(status);
      reasons.push(reason);
      flags.push(flag);
      changed.push(status !== r.status || reason !== r.statusReason);
    }
    if (ids.length > 0) {
      const updated = await tx.$executeRaw`
        UPDATE public.admission_applications a
           SET status = v.status::public.admission_application_status,
               status_reason = CASE WHEN v.changed THEN v.reason ELSE a.status_reason END,
               status_by = CASE WHEN v.changed THEN ${actor}::uuid ELSE a.status_by END,
               status_at = CASE WHEN v.changed THEN ${now}::timestamptz ELSE a.status_at END,
               approval_problem = CASE WHEN v.changed THEN NULL ELSE a.approval_problem END,
               approval_problem_at = CASE WHEN v.changed THEN NULL ELSE a.approval_problem_at END,
               result_version = ${version}::int,
               result_merit_position = a.merit_position,
               result_waitlist_position = a.waitlist_position,
               result_score_h = a.test_score_h,
               result_absent = a.test_absent,
               result_flag = v.flag,
               updated_at = now()
          FROM unnest(${ids}::uuid[], ${before}::text[], ${statuses}::text[], ${reasons}::text[],
                      ${flags}::text[], ${changed}::boolean[])
               AS v(id, before, status, reason, flag, changed)
         WHERE a.id = v.id AND a.status = v.before::public.admission_application_status`;
      // The rows are locked, so this holds; if it ever does not, nothing is published.
      if (updated !== ids.length) {
        throw apiError(409, 'MERIT_STALE', 'The list changed while publishing: build it again');
      }
    }
    await tx.admissionCycleClass.update({
      where: { id },
      data: {
        resultsVersion: version,
        resultsPublishedAt: now,
        resultsFullMarks: cls.fullMarks,
        resultsBuiltAt: cls.meritBuiltAt,
      },
      select: { id: true },
    });
    await this.audit.record({
      entity: 'admission_merit_publish',
      entityId: id,
      action: 'UPDATE',
      oldValues: { version: cls.resultsVersion },
      newValues: {
        version,
        builtAt,
        counts: Object.fromEntries(Object.entries(byOutcome).map(([k, v]) => [k, v.length])),
        byOutcome,
        flagged,
      },
    });
    return this.view(id);
  }

  /**
   * POST …/move-up (decision P4-G): a staff action, never automatic. The first on the published
   * waitlist becomes SELECTED when a seat is free (selected + admitted below the seats); everyone
   * sharing that first position moves together (a tie is never split, as P4-B), and the rest of
   * the waitlist renumbers. The applicant learns it through the result SMS preview → send.
   */
  async moveUp(id: string): Promise<AdmissionMoveUpResult> {
    const tx = this.db.tx;
    const cls = await this.test.lockClass(id);
    this.test.requireTest(cls);
    if (cls.resultsVersion === 0) {
      throw apiError(422, 'NOT_PUBLISHED', 'Publish the merit list first');
    }
    await tx.$queryRaw`
      SELECT id FROM public.admission_applications
       WHERE cycle_class_id = ${id}::uuid AND status IN ('WAITLISTED', 'SELECTED', 'ADMITTED')
       ORDER BY id FOR NO KEY UPDATE`;
    const [waiting, seated] = await Promise.all([
      tx.admissionApplication.findMany({
        where: {
          cycleClassId: id,
          status: 'WAITLISTED',
          resultVersion: cls.resultsVersion,
          resultWaitlistPosition: { not: null },
        },
        orderBy: [{ resultWaitlistPosition: 'asc' }, { id: 'asc' }],
        select: { id: true, applicationNo: true, resultWaitlistPosition: true },
      }),
      tx.admissionApplication.count({
        where: { cycleClassId: id, status: { in: ['SELECTED', 'ADMITTED'] } },
      }),
    ]);
    if (waiting.length === 0) {
      throw apiError(422, 'WAITLIST_EMPTY', 'Nobody is on the waitlist');
    }
    if (seated >= (cls.selectCount ?? 0)) {
      throw apiError(422, 'NO_SEAT_FREE', 'Every seat is taken', { seated });
    }
    const first = waiting[0]!.resultWaitlistPosition;
    const moving = waiting.filter((w) => w.resultWaitlistPosition === first);
    const staying = waiting.filter((w) => w.resultWaitlistPosition !== first);
    const now = this.clock.now();
    const actor = this.context.requirePrincipal().userId;
    for (const m of moving) {
      await tx.admissionApplication.update({
        where: { id: m.id },
        data: {
          status: 'SELECTED',
          statusReason: null,
          statusBy: actor,
          statusAt: now,
          resultWaitlistPosition: null,
        },
        select: { id: true },
      });
      await this.audit.record({
        entity: 'admission_application',
        entityId: m.id,
        action: 'UPDATE',
        oldValues: { status: 'WAITLISTED', waitlistPosition: first },
        newValues: { status: 'SELECTED', reason: 'MOVED_UP' },
      });
    }
    // The rest renumber from 1, ties still sharing a position.
    let prevOld: number | null = null;
    let prevNew = 0;
    for (let i = 0; i < staying.length; i++) {
      const w = staying[i]!;
      const next = w.resultWaitlistPosition === prevOld ? prevNew : i + 1;
      prevOld = w.resultWaitlistPosition;
      prevNew = next;
      if (next !== w.resultWaitlistPosition) {
        await tx.admissionApplication.update({
          where: { id: w.id },
          data: { resultWaitlistPosition: next },
          select: { id: true },
        });
        // A published position changes: audited like any published value (review N2).
        await this.audit.record({
          entity: 'admission_application',
          entityId: w.id,
          action: 'UPDATE',
          oldValues: { waitlistPosition: w.resultWaitlistPosition },
          newValues: { waitlistPosition: next, reason: 'MOVED_UP' },
        });
      }
    }
    return { moved: moving.map((m) => ({ applicationId: m.id, applicationNo: m.applicationNo })) };
  }
}

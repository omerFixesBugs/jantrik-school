import { createHash } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { PromotionApplyCheck } from '@jantrik/shared';
import type { Queue } from 'bullmq';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import { SubjectChoicesCopier } from '../exams/setup/subject-choices-copier.js';
import { Db } from '../tenancy/db.service.js';
import {
  applyJobId,
  LIVE_JOB_STATES,
  PROMOTION_APPLY_JOB,
  PROMOTIONS_QUEUE,
} from './promotion-queue.js';
import { PromotionService } from './promotion.service.js';

export { applyJobId, PROMOTION_APPLY_JOB, PROMOTIONS_QUEUE } from './promotion-queue.js';

/** Ids only (never personal data in Redis). */
export interface PromotionApplyJobData {
  tenantId: string;
  runId: string;
  actorUserId: string;
}

/** Leavers per transaction. */
export const LEAVERS_PER_CHUNK = 200;

export interface SectionOutcome {
  enrolled: number;
  alreadyEnrolled: number;
  skipped: number;
}

/**
 * Applying a run (review focus 1 and 2). The request side checks and starts it (DRAFT, or
 * APPLIED with new pending rows → APPLYING) and queues one job per run (job id
 * `promotion-apply-<runId>`). The job side applies one target section per transaction under a
 * per-run advisory lock, each row once (`applied_at`), then the leavers in chunks, then marks the
 * run APPLIED. A stopped job resumes where it stopped; two executions never apply a row twice.
 * It never touches `academic_years.is_current`.
 */
@Injectable()
export class PromotionApplyService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly promotions: PromotionService,
    private readonly choices: SubjectChoicesCopier,
    @InjectQueue(PROMOTIONS_QUEUE) private readonly queue: Queue,
  ) {}

  // ─────────────────────────── Request side ───────────────────────────

  /** Capacity per target section, rows without a section, counts, and the version. */
  async check(id: string): Promise<PromotionApplyCheck> {
    const tx = this.db.tx;
    const run = await tx.promotionRun.findUnique({
      where: { id },
      select: { id: true, status: true, toYearId: true },
    });
    if (!run) throw new NotFoundException('Promotion run not found');
    const pending = await tx.promotionRunStudent.findMany({
      where: { runId: id, appliedAt: null },
      select: {
        id: true,
        studentId: true,
        decision: true,
        targetSectionId: true,
        targetClassLevelId: true,
        updatedAt: true,
      },
      orderBy: { id: 'asc' },
    });
    const staying = pending.filter((r) => r.decision !== 'LEAVE');
    const sectionIds = [
      ...new Set(staying.map((r) => r.targetSectionId).filter((s) => s !== null)),
    ];
    const sections = await tx.section.findMany({
      where: { id: { in: sectionIds } },
      select: {
        id: true,
        name: true,
        capacity: true,
        isActive: true,
        classLevel: { select: { id: true, nameBn: true, nameEn: true, sortOrder: true } },
      },
      orderBy: [{ classLevel: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    const enrolled = await tx.enrolment.groupBy({
      by: ['sectionId'],
      where: { sectionId: { in: sectionIds }, student: { deletedAt: null } },
      _count: { _all: true },
    });
    const already = new Set(
      (
        await tx.enrolment.findMany({
          where: {
            academicYearId: run.toYearId,
            studentId: { in: staying.map((r) => r.studentId) },
          },
          select: { studentId: true },
        })
      ).map((e) => e.studentId),
    );
    const view = sections.map((s) => {
      const now = enrolled.find((g) => g.sectionId === s.id)?._count._all ?? 0;
      const incoming = staying.filter(
        (r) => r.targetSectionId === s.id && !already.has(r.studentId),
      ).length;
      return {
        section: { id: s.id, name: s.name },
        classLevel: {
          id: s.classLevel.id,
          nameBn: s.classLevel.nameBn,
          nameEn: s.classLevel.nameEn,
        },
        capacity: s.capacity,
        enrolled: now,
        incoming,
        full: s.capacity !== null && now + incoming > s.capacity,
        isActive: s.isActive,
      };
    });
    const version = createHash('sha256')
      .update(
        JSON.stringify([
          run.status,
          pending.map((r) => [r.id, r.decision, r.targetSectionId, r.updatedAt.getTime()]),
          view.map((v) => [v.section.id, v.capacity, v.enrolled, v.isActive]),
        ]),
      )
      .digest('hex')
      .slice(0, 32);
    return {
      runId: run.id,
      status: run.status,
      sections: view.map(({ isActive: _active, ...v }) => v),
      withoutSection: staying.filter((r) => !r.targetSectionId).length,
      pending: {
        promote: pending.filter((r) => r.decision === 'PROMOTE').length,
        repeat: pending.filter((r) => r.decision === 'REPEAT').length,
        leave: pending.filter((r) => r.decision === 'LEAVE').length,
      },
      version,
    };
  }

  /**
   * Starts applying (P5-E): refused while it is already applying (409 RUN_APPLYING; two admins
   * at once take turns on the run's lock), when the check changed since the admin saw it (409
   * PREVIEW_CHANGED), and while a target section would overflow (422 SECTION_FULL, listed).
   */
  async start(id: string, version: string) {
    const run = await this.promotions.lockRun(id);
    if (run.status === 'APPLYING')
      throw apiError(409, 'RUN_APPLYING', 'This run is already being applied');
    const check = await this.check(id);
    const pending = check.pending.promote + check.pending.repeat + check.pending.leave;
    if (pending === 0) throw apiError(422, 'NOTHING_TO_APPLY', 'No row is waiting to be applied');
    if (check.version !== version)
      throw apiError(409, 'PREVIEW_CHANGED', 'Something changed; check again before applying');
    const full = check.sections.filter((s) => s.full);
    if (full.length > 0)
      throw apiError(422, 'SECTION_FULL', 'Some sections would be over capacity', {
        sections: full.map((s) => ({
          sectionId: s.section.id,
          capacity: s.capacity,
          enrolled: s.enrolled,
          incoming: s.incoming,
        })),
      });
    await this.assertTargetsActive(id);
    const actorUserId = this.context.requirePrincipal().userId;
    await this.db.tx.promotionRun.update({
      where: { id },
      data: {
        status: 'APPLYING',
        appliedById: actorUserId,
        applyStartedAt: new Date(),
        appliedAt: null,
        lastError: null,
      },
    });
    await this.audit.record({
      entity: 'promotion_run',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: run.status },
      newValues: { status: 'APPLYING', step: 'apply', pending: check.pending },
    });
    const tenantId = this.context.requireTenantId();
    await this.context.afterCommit(() => this.enqueue({ tenantId, runId: id, actorUserId }));
    return this.promotions.detail(id);
  }

  /** An APPLYING run whose job is no longer running: queue it again (as this admin). */
  async resume(id: string) {
    const run = await this.promotions.lockRun(id);
    if (run.status !== 'APPLYING')
      throw apiError(422, 'NOT_APPLYING', 'This run is not being applied');
    if (await this.jobIsLive(id))
      throw apiError(409, 'RUN_APPLYING', 'The run is still being applied');
    await this.assertTargetsActive(id);
    const actorUserId = this.context.requirePrincipal().userId;
    await this.db.tx.promotionRun.update({
      where: { id },
      data: { appliedById: actorUserId, lastError: null },
    });
    await this.audit.record({
      entity: 'promotion_run',
      entityId: id,
      action: 'UPDATE',
      oldValues: { lastError: run.lastError },
      newValues: { step: 'resume' },
    });
    const tenantId = this.context.requireTenantId();
    await this.context.afterCommit(() => this.enqueue({ tenantId, runId: id, actorUserId }));
    return this.promotions.detail(id);
  }

  /** Pending rows into a section that was deactivated, or into a class no longer active. */
  private async assertTargetsActive(id: string) {
    const bad = await this.db.tx.promotionRunStudent.findMany({
      where: {
        runId: id,
        appliedAt: null,
        decision: { not: 'LEAVE' },
        OR: [
          { targetSection: { isActive: false } },
          { targetClassLevel: { isActive: false } },
          { targetStudyGroup: { isActive: false } },
        ],
      },
      select: { id: true },
    });
    if (bad.length > 0)
      throw apiError(422, 'TARGET_INVALID', 'Some rows go into a deactivated class or section', {
        rowIds: bad.map((r) => r.id),
      });
  }

  jobIsLive(runId: string): Promise<boolean> {
    return this.promotions.jobIsLive(runId);
  }

  /**
   * One job per run: a finished or failed job of the same id is removed first (BullMQ would
   * otherwise ignore the new one); a live one is left alone.
   */
  async enqueue(data: PromotionApplyJobData): Promise<void> {
    const jobId = applyJobId(data.runId);
    const old = await this.queue.getJob(jobId);
    if (old) {
      if (LIVE_JOB_STATES.has(await old.getState())) return;
      await old.remove();
    }
    await this.queue.add(PROMOTION_APPLY_JOB, data, {
      jobId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: true,
      removeOnFail: 50,
    });
  }

  // ─────────────────────────── Job side (in the job's tenant transaction) ───────────────────────────

  private async lockForApply(runId: string) {
    const tx = this.db.tx;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('promotion:' || ${runId}, 0))`;
    return tx.promotionRun.findUnique({
      where: { id: runId },
      select: { id: true, status: true, fromYearId: true, toYearId: true, classLevelId: true },
    });
  }

  /** The target sections with pending PROMOTE/REPEAT rows (null = without a section). */
  async pendingSections(
    runId: string,
  ): Promise<{ applying: boolean; sections: (string | null)[] }> {
    const run = await this.db.tx.promotionRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (run?.status !== 'APPLYING') return { applying: false, sections: [] };
    const rows = await this.db.tx.promotionRunStudent.findMany({
      where: { runId, appliedAt: null, decision: { not: 'LEAVE' } },
      select: { targetSectionId: true },
      distinct: ['targetSectionId'],
    });
    const ids = rows.map((r) => r.targetSectionId);
    return {
      applying: true,
      sections: [
        ...ids.filter((s): s is string => s !== null).sort(),
        ...(ids.includes(null) ? [null] : []),
      ],
    };
  }

  /**
   * One target section's pending PROMOTE/REPEAT rows (null: those without a section), in one
   * transaction: capacity checked with the section locked (as an admission does), then per row
   * deactivated → SKIPPED_DEACTIVATED, left another way → SKIPPED_LEFT, already enrolled in the
   * to-year → ALREADY_ENROLLED (left as is, P5-D), else a new enrolment without a roll →
   * ENROLLED. Repeaters' subject choices are copied (P5-H). A concurrent enrolment of the same
   * student is skipped by the unique (year, student) and counts as ALREADY_ENROLLED.
   */
  async applySection(runId: string, sectionId: string | null): Promise<SectionOutcome> {
    const tx = this.db.tx;
    const outcome: SectionOutcome = { enrolled: 0, alreadyEnrolled: 0, skipped: 0 };
    const run = await this.lockForApply(runId);
    if (!run || run.status !== 'APPLYING') return outcome;
    const rows = await tx.promotionRunStudent.findMany({
      where: { runId, appliedAt: null, decision: { not: 'LEAVE' }, targetSectionId: sectionId },
      select: {
        id: true,
        studentId: true,
        decision: true,
        targetClassLevelId: true,
        targetStudyGroupId: true,
      },
      orderBy: { id: 'asc' },
    });
    if (rows.length === 0) return outcome;

    let capacity: number | null = null;
    if (sectionId) {
      const [section] = await tx.$queryRaw<{ capacity: number | null; is_active: boolean }[]>`
        SELECT capacity, is_active FROM sections WHERE id = ${sectionId}::uuid FOR UPDATE`;
      if (!section?.is_active)
        throw apiError(422, 'TARGET_INVALID', 'The target section is deactivated', { sectionId });
      capacity = section.capacity;
    }
    const studentIds = rows.map((r) => r.studentId);
    // The students stay as read until this transaction ends: a leave or deactivation committing
    // meanwhile waits, so no one who just left is enrolled (review NIT 9).
    await tx.$queryRaw`SELECT id FROM students WHERE id = ANY(${studentIds}::uuid[]) FOR SHARE`;
    const students = new Map(
      (
        await tx.student.findMany({
          where: { id: { in: studentIds } },
          select: { id: true, status: true, deletedAt: true },
        })
      ).map((s) => [s.id, s]),
    );
    const existing = new Map(
      (
        await tx.enrolment.findMany({
          where: { academicYearId: run.toYearId, studentId: { in: studentIds } },
          select: { id: true, studentId: true },
        })
      ).map((e) => [e.studentId, e.id]),
    );
    const results = new Map<
      string,
      {
        outcome: 'ENROLLED' | 'ALREADY_ENROLLED' | 'SKIPPED_DEACTIVATED' | 'SKIPPED_LEFT';
        enrolmentId: string | null;
      }
    >();
    const toCreate: typeof rows = [];
    for (const r of rows) {
      const s = students.get(r.studentId);
      if (!s || s.deletedAt)
        results.set(r.id, { outcome: 'SKIPPED_DEACTIVATED', enrolmentId: null });
      else if (s.status !== 'ACTIVE')
        results.set(r.id, { outcome: 'SKIPPED_LEFT', enrolmentId: null });
      else if (existing.has(r.studentId))
        results.set(r.id, { outcome: 'ALREADY_ENROLLED', enrolmentId: existing.get(r.studentId)! });
      else toCreate.push(r);
    }
    if (sectionId && capacity !== null && toCreate.length > 0) {
      const now = await tx.enrolment.count({
        where: { sectionId, student: { deletedAt: null } },
      });
      if (now + toCreate.length > capacity)
        throw apiError(422, 'SECTION_FULL', 'The section would be over capacity', {
          sectionId,
          capacity,
          enrolled: now,
          incoming: toCreate.length,
        });
    }
    const tenantId = this.context.requireTenantId();
    const created =
      toCreate.length === 0
        ? []
        : await tx.enrolment.createManyAndReturn({
            data: toCreate.map((r) => ({
              tenantId,
              studentId: r.studentId,
              academicYearId: run.toYearId,
              classLevelId: r.targetClassLevelId!,
              sectionId,
              studyGroupId: r.targetStudyGroupId,
              roll: null,
            })),
            skipDuplicates: true,
            select: { id: true, studentId: true },
          });
    const createdBy = new Map(created.map((e) => [e.studentId, e.id]));
    const raced = toCreate.filter((r) => !createdBy.has(r.studentId)).map((r) => r.studentId);
    const racedEnrolments = new Map(
      raced.length === 0
        ? []
        : (
            await tx.enrolment.findMany({
              where: { academicYearId: run.toYearId, studentId: { in: raced } },
              select: { id: true, studentId: true },
            })
          ).map((e) => [e.studentId, e.id]),
    );
    for (const r of toCreate) {
      const id = createdBy.get(r.studentId);
      if (id) results.set(r.id, { outcome: 'ENROLLED', enrolmentId: id });
      else
        results.set(r.id, {
          outcome: 'ALREADY_ENROLLED',
          enrolmentId: racedEnrolments.get(r.studentId)!,
        });
    }

    // P5-H: repeaters keep their subject choices (the same class's subjects, still active).
    const repeaters = toCreate
      .filter((r) => r.decision === 'REPEAT' && createdBy.has(r.studentId))
      .map((r) => r.studentId);
    await this.choices.copyForRepeaters(repeaters, run.fromYearId, run.toYearId, run.classLevelId);

    const appliedAt = new Date();
    for (const r of rows) {
      const res = results.get(r.id)!;
      await tx.promotionRunStudent.updateMany({
        where: { id: r.id, appliedAt: null },
        data: { appliedAt, applyOutcome: res.outcome, toEnrolmentId: res.enrolmentId },
      });
      if (res.outcome === 'ENROLLED') outcome.enrolled++;
      else if (res.outcome === 'ALREADY_ENROLLED') outcome.alreadyEnrolled++;
      else outcome.skipped++;
    }
    await this.audit.record({
      entity: 'promotion_run',
      entityId: runId,
      action: 'UPDATE',
      newValues: { step: 'promotion_apply', sectionId, ...outcome },
    });
    return outcome;
  }

  /**
   * Up to `limit` pending LEAVE rows: the student's status, date and reason are set where they
   * are still ACTIVE and not deleted (one audit row each); otherwise the outcome says what was
   * there. Rolls stay (history). Returns how many rows were handled (0: none left).
   */
  async applyLeavers(runId: string, limit = LEAVERS_PER_CHUNK): Promise<number> {
    const tx = this.db.tx;
    const run = await this.lockForApply(runId);
    if (!run || run.status !== 'APPLYING') return 0;
    const rows = await tx.promotionRunStudent.findMany({
      where: { runId, appliedAt: null, decision: 'LEAVE' },
      select: { id: true, studentId: true, leaveStatus: true, leftOn: true, leaveReason: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
    const appliedAt = new Date();
    for (const r of rows) {
      const { count } = await tx.student.updateMany({
        where: { id: r.studentId, status: 'ACTIVE', deletedAt: null },
        data: { status: r.leaveStatus!, leftOn: r.leftOn, leaveReason: r.leaveReason },
      });
      let outcome: 'LEFT' | 'SKIPPED_DEACTIVATED' | 'SKIPPED_LEFT' = 'LEFT';
      if (count === 1) {
        await this.audit.record({
          entity: 'student',
          entityId: r.studentId,
          action: 'UPDATE',
          oldValues: { status: 'ACTIVE' },
          newValues: {
            status: r.leaveStatus,
            leftOn: r.leftOn ? r.leftOn.toISOString().slice(0, 10) : null,
            leaveReason: r.leaveReason,
            promotionRunId: runId,
          },
        });
      } else {
        const s = await tx.student.findUnique({
          where: { id: r.studentId },
          select: { deletedAt: true },
        });
        outcome = !s || s.deletedAt ? 'SKIPPED_DEACTIVATED' : 'SKIPPED_LEFT';
      }
      await tx.promotionRunStudent.updateMany({
        where: { id: r.id, appliedAt: null },
        data: { appliedAt, applyOutcome: outcome },
      });
    }
    return rows.length;
  }

  /** No pending row left: the run is APPLIED. Returns whether it is. */
  async finish(runId: string): Promise<boolean> {
    const tx = this.db.tx;
    const run = await this.lockForApply(runId);
    if (!run || run.status !== 'APPLYING') return run?.status === 'APPLIED';
    const pending = await tx.promotionRunStudent.count({ where: { runId, appliedAt: null } });
    if (pending > 0) return false;
    await tx.promotionRun.update({
      where: { id: runId },
      data: { status: 'APPLIED', appliedAt: new Date(), lastError: null },
    });
    const outcomes = await tx.promotionRunStudent.groupBy({
      by: ['applyOutcome'],
      where: { runId },
      _count: { _all: true },
    });
    await this.audit.record({
      entity: 'promotion_run',
      entityId: runId,
      action: 'UPDATE',
      oldValues: { status: 'APPLYING' },
      newValues: {
        status: 'APPLIED',
        outcomes: Object.fromEntries(outcomes.map((o) => [o.applyOutcome, o._count._all])),
      },
    });
    return true;
  }

  /** The run stays APPLYING with a fixed error code for the admin (never a message). */
  async markError(runId: string, code: string): Promise<void> {
    const { count } = await this.db.tx.promotionRun.updateMany({
      where: { id: runId, status: 'APPLYING' },
      data: { lastError: code },
    });
    if (count > 0)
      await this.audit.record({
        entity: 'promotion_run',
        entityId: runId,
        action: 'UPDATE',
        newValues: { step: 'stopped', lastError: code },
      });
  }
}

/** A fixed error code for `last_error` (never a message: database errors can hold values). */
export function applyErrorCode(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    const code =
      typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code)) return code;
  }
  const prismaCode = (error as { code?: unknown } | null)?.code;
  if (prismaCode === 'P2028' || prismaCode === 'P1008') return 'TIMEOUT';
  if (error instanceof Error && error.message === 'INCOMPLETE') return 'INCOMPLETE';
  return 'ERROR';
}

/** Errors that another attempt cannot fix: the admin has to act, then resume. */
export const PERMANENT_ERRORS = new Set(['SECTION_FULL', 'TARGET_INVALID', 'ACTOR_NOT_ADMIN']);

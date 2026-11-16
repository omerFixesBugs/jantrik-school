import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@jantrik/db';
import {
  dateFromDb,
  dateToDb,
  nextClassLevel,
  type CreatePromotionRunInput,
  type LeaveStatus,
  type PromotionRowEdit,
  type PromotionRowView,
  type PromotionRunCounts,
  type PromotionRunDetail,
  type PromotionRunsOverview,
  type PromotionRunSummary,
  type RollStrategy,
  type UpdatePromotionRunInput,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import { ExamResultsReader } from '../exams/results/exam-results-reader.js';
import { Db } from '../tenancy/db.service.js';

const NAMES = { select: { id: true, nameBn: true, nameEn: true } } as const;

const RUN_INCLUDE = {
  fromYear: { select: { id: true, name: true } },
  toYear: { select: { id: true, name: true } },
  classLevel: { select: { id: true, nameBn: true, nameEn: true, sortOrder: true } },
  meritExam: NAMES,
} satisfies Prisma.PromotionRunInclude;

type RunRow = Prisma.PromotionRunGetPayload<{ include: typeof RUN_INCLUDE }>;

interface CountRow {
  runId: string;
  decision: 'PROMOTE' | 'REPEAT' | 'LEAVE';
  appliedAt: Date | null;
  targetSectionId: string | null;
  resultPassed: boolean | null;
}

export interface YearRow {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  isCurrent: boolean;
}

/** What a new row of a run gets (P5-F, P5-G, S15, P5-I). */
interface NewRow {
  studentId: string;
  fromEnrolmentId: string;
  fromSectionId: string | null;
  fromRoll: number | null;
  resultPassed: boolean | null;
  meritPosition: number | null;
  decision: 'PROMOTE' | 'REPEAT' | 'LEAVE';
  targetClassLevelId: string | null;
  targetSectionId: string | null;
  targetStudyGroupId: string | null;
  leaveStatus: LeaveStatus | null;
  leftOn: Date | null;
}

/**
 * Promotion runs (sprint 1 P5, docs/promotion.md): one per from-year, to-year and from-class,
 * with one row per student and the defaults from the published results. Rows are edited while
 * pending; a run being applied (APPLYING) is not edited. Everything is audited. Applying, the
 * roll numbering and the switch check are their own services.
 */
@Injectable()
export class PromotionService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly results: ExamResultsReader,
  ) {}

  private get tenantId(): string {
    return this.context.requireTenantId();
  }

  // ─────────────────────────── Years and classes ───────────────────────────

  async year(id: string): Promise<YearRow> {
    const year = await this.db.tx.academicYear.findUnique({
      where: { id },
      select: { id: true, name: true, startDate: true, endDate: true, isCurrent: true },
    });
    if (!year) throw new NotFoundException('Academic year not found');
    return year;
  }

  /** The year just before `toYear` (by start date): where its runs come from. */
  async previousYear(toYear: { startDate: Date }): Promise<YearRow | null> {
    return this.db.tx.academicYear.findFirst({
      where: { startDate: { lt: toYear.startDate } },
      orderBy: { startDate: 'desc' },
      select: { id: true, name: true, startDate: true, endDate: true, isCurrent: true },
    });
  }

  async examsEnabled(): Promise<boolean> {
    const n = await this.db.tx.tenantModule.count({
      where: { moduleKey: 'EXAMS', enabled: true },
    });
    return n > 0;
  }

  /**
   * Classes of `fromYear` with ACTIVE students but no run into `toYearId`, with their counts.
   */
  async classesWithoutRun(fromYear: YearRow, toYearId: string) {
    const tx = this.db.tx;
    const groups = await tx.enrolment.groupBy({
      by: ['classLevelId'],
      where: {
        academicYearId: fromYear.id,
        student: { deletedAt: null, status: 'ACTIVE' },
      },
      _count: { _all: true },
    });
    const withRun = new Set(
      (
        await tx.promotionRun.findMany({
          where: { fromYearId: fromYear.id, toYearId },
          select: { classLevelId: true },
        })
      ).map((r) => r.classLevelId),
    );
    const ids = groups.map((g) => g.classLevelId).filter((id) => !withRun.has(id));
    const classes = await tx.classLevel.findMany({
      where: { id: { in: ids } },
      select: { id: true, nameBn: true, nameEn: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return classes.map((c) => ({
      id: c.id,
      nameBn: c.nameBn,
      nameEn: c.nameEn,
      students: groups.find((g) => g.classLevelId === c.id)?._count._all ?? 0,
    }));
  }

  // ─────────────────────────── Reading ───────────────────────────

  async overview(toYearId: string): Promise<PromotionRunsOverview> {
    const toYear = await this.year(toYearId);
    const fromYear = await this.previousYear(toYear);
    const runs = await this.db.tx.promotionRun.findMany({
      where: { toYearId },
      include: RUN_INCLUDE,
      orderBy: [{ classLevel: { sortOrder: 'asc' } }, { id: 'asc' }],
    });
    const counts = await this.counts(runs.map((r) => r.id));
    return {
      toYear: { id: toYear.id, name: toYear.name },
      fromYear: fromYear ? { id: fromYear.id, name: fromYear.name } : null,
      runs: runs.map((r) => toSummary(r, counts.get(r.id) ?? emptyCounts())),
      classesWithoutRun: fromYear ? await this.classesWithoutRun(fromYear, toYearId) : [],
    };
  }

  async detail(id: string): Promise<PromotionRunDetail> {
    const tx = this.db.tx;
    const run = await tx.promotionRun.findUnique({ where: { id }, include: RUN_INCLUDE });
    if (!run) throw new NotFoundException('Promotion run not found');
    const rows = await tx.promotionRunStudent.findMany({
      where: { runId: id },
      include: {
        student: {
          select: {
            id: true,
            studentCode: true,
            nameBn: true,
            nameEn: true,
            status: true,
            deletedAt: true,
          },
        },
        fromSection: { select: { id: true, name: true } },
        targetClassLevel: NAMES,
        targetSection: { select: { id: true, name: true } },
        targetStudyGroup: NAMES,
      },
      orderBy: [
        { fromSection: { name: 'asc' } },
        { fromRoll: { sort: 'asc', nulls: 'last' } },
        { student: { studentCode: 'asc' } },
        { id: 'asc' },
      ],
    });
    const counts = await this.counts([id]);
    const classes = await tx.classLevel.findMany({
      select: { id: true, nameBn: true, nameEn: true, sortOrder: true, isActive: true },
    });
    const next = nextClassLevel(classes, run.classLevelId);
    return {
      ...toSummary(run, counts.get(id) ?? emptyCounts()),
      nextClassLevel: next ? { id: next.id, nameBn: next.nameBn, nameEn: next.nameEn } : null,
      rows: rows.map((r): PromotionRowView => ({
        id: r.id,
        student: {
          id: r.student.id,
          studentCode: r.student.studentCode,
          nameBn: r.student.nameBn,
          nameEn: r.student.nameEn,
          status: r.student.status,
          deactivated: r.student.deletedAt !== null,
        },
        fromSection: r.fromSection,
        fromRoll: r.fromRoll,
        resultPassed: r.resultPassed,
        meritPosition: r.meritPosition,
        noResult: r.resultPassed === null,
        decision: r.decision,
        targetClassLevel: r.targetClassLevel,
        targetSection: r.targetSection,
        targetStudyGroup: r.targetStudyGroup,
        leaveStatus: r.leaveStatus as LeaveStatus | null,
        leftOn: r.leftOn ? dateFromDb(r.leftOn) : null,
        leaveReason: r.leaveReason,
        appliedAt: r.appliedAt?.toISOString() ?? null,
        applyOutcome: r.applyOutcome,
        toEnrolmentId: r.toEnrolmentId,
      })),
    };
  }

  private async counts(runIds: string[]): Promise<Map<string, PromotionRunCounts>> {
    const out = new Map<string, PromotionRunCounts>();
    if (runIds.length === 0) return out;
    const rows: CountRow[] = await this.db.tx.promotionRunStudent.findMany({
      where: { runId: { in: runIds } },
      select: {
        runId: true,
        decision: true,
        appliedAt: true,
        targetSectionId: true,
        resultPassed: true,
      },
    });
    for (const r of rows) {
      const c = out.get(r.runId) ?? emptyCounts();
      c.total++;
      if (r.decision === 'PROMOTE') c.promote++;
      if (r.decision === 'REPEAT') c.repeat++;
      if (r.decision === 'LEAVE') c.leave++;
      if (!r.appliedAt) c.pending++;
      if (r.decision !== 'LEAVE' && !r.targetSectionId) c.withoutSection++;
      if (r.resultPassed === null) c.noResult++;
      out.set(r.runId, c);
    }
    return out;
  }

  // ─────────────────────────── Creating ───────────────────────────

  /** A run for one class with its rows and their defaults (P5-F, P5-G). */
  async create(input: CreatePromotionRunInput): Promise<PromotionRunDetail> {
    const tx = this.db.tx;
    const fromYear = await this.year(input.fromYearId);
    const toYear = await this.year(input.toYearId);
    if (toYear.startDate.getTime() <= fromYear.startDate.getTime())
      throw apiError(422, 'YEAR_ORDER', 'The new year must start after the year it comes from', {
        field: 'toYearId',
      });
    const classLevel = await tx.classLevel.findUnique({
      where: { id: input.classLevelId },
      select: { id: true },
    });
    if (!classLevel) throw new NotFoundException('Class level not found');
    const existing = await tx.promotionRun.findFirst({
      where: { fromYearId: fromYear.id, toYearId: toYear.id, classLevelId: classLevel.id },
      select: { id: true },
    });
    if (existing)
      throw apiError(409, 'RUN_EXISTS', 'This class already has a run into that year', {
        runId: existing.id,
      });
    const merit = await this.meritChoice({
      examId: input.meritExamId,
      strategy: input.rollStrategy,
      fromYearId: fromYear.id,
      classLevelId: classLevel.id,
      useDefault: true,
    });

    let run: { id: string };
    try {
      run = await tx.promotionRun.create({
        data: {
          tenantId: this.tenantId,
          fromYearId: fromYear.id,
          toYearId: toYear.id,
          classLevelId: classLevel.id,
          rollStrategy: merit.strategy,
          meritExamId: merit.examId,
          createdById: this.context.requirePrincipal().userId,
        },
        select: { id: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw apiError(409, 'RUN_EXISTS', 'This class already has a run into that year');
      throw error;
    }
    const rows = await this.newRows({
      fromYear,
      toYearId: toYear.id,
      classLevelId: classLevel.id,
      meritExamId: merit.examId,
    });
    await this.insertRows(run.id, toYear.id, rows);
    await this.audit.record({
      entity: 'promotion_run',
      entityId: run.id,
      action: 'CREATE',
      newValues: {
        fromYearId: fromYear.id,
        toYearId: toYear.id,
        classLevelId: classLevel.id,
        rollStrategy: merit.strategy,
        meritExamId: merit.examId,
        rows: rows.length,
        promote: rows.filter((r) => r.decision === 'PROMOTE').length,
        repeat: rows.filter((r) => r.decision === 'REPEAT').length,
        leave: rows.filter((r) => r.decision === 'LEAVE').length,
      },
    });
    return this.detail(run.id);
  }

  /**
   * The merit exam and roll strategy (P5-G). MERIT needs the EXAMS module and a published exam of
   * the from-year for the class; without one given, the latest published ANNUAL exam is the
   * default. Without EXAMS, results are not used at all.
   */
  async meritChoice(opts: {
    examId: string | null;
    strategy: RollStrategy | undefined;
    fromYearId: string;
    classLevelId: string;
    useDefault: boolean;
  }): Promise<{ examId: string | null; strategy: RollStrategy }> {
    let examId = opts.examId;
    if (!(await this.examsEnabled())) {
      if (opts.strategy === 'MERIT' || examId)
        throw apiError(422, 'MERIT_NEEDS_EXAMS', 'Merit order needs the exams module', {
          reason: 'MODULE',
        });
      return { examId: null, strategy: opts.strategy ?? 'NAME_BN' };
    }
    if (examId) {
      if (!(await this.results.isPublishedFor(examId, opts.fromYearId, opts.classLevelId)))
        throw apiError(422, 'MERIT_EXAM_INVALID', 'Not a published exam of that year and class', {
          field: 'meritExamId',
        });
    } else if (opts.useDefault) {
      examId =
        (await this.results.publishedExams(opts.fromYearId, opts.classLevelId, 'ANNUAL'))[0]?.id ??
        null;
    }
    const strategy = opts.strategy ?? (examId ? 'MERIT' : 'NAME_BN');
    if (strategy === 'MERIT' && !examId)
      throw apiError(422, 'MERIT_NEEDS_EXAMS', 'Merit order needs a published exam', {
        reason: 'NO_EXAM',
      });
    return { examId, strategy };
  }

  /**
   * Rows for the ACTIVE students of the from-class who are in no run into the to-year yet
   * (`onlyStudentIds`: limited to those). Defaults (P5-F): the top class leaves as GRADUATED on
   * the from-year's last day (a failed student there repeats); otherwise a failed result repeats
   * and everyone else (passed or no result) is promoted into the next class. Target section: the
   * same name in the target class of the to-year (S15); the study group is kept (P5-I).
   */
  async newRows(opts: {
    fromYear: YearRow;
    toYearId: string;
    classLevelId: string;
    meritExamId: string | null;
  }): Promise<NewRow[]> {
    const tx = this.db.tx;
    const enrolments = await tx.enrolment.findMany({
      where: {
        academicYearId: opts.fromYear.id,
        classLevelId: opts.classLevelId,
        student: { deletedAt: null, status: 'ACTIVE' },
      },
      select: {
        id: true,
        studentId: true,
        sectionId: true,
        roll: true,
        studyGroupId: true,
        section: { select: { name: true } },
        studyGroup: { select: { isActive: true } },
      },
      orderBy: { id: 'asc' },
    });
    if (enrolments.length === 0) return [];
    const inRun = new Set(
      (
        await tx.promotionRunStudent.findMany({
          where: { toYearId: opts.toYearId, studentId: { in: enrolments.map((e) => e.studentId) } },
          select: { studentId: true },
        })
      ).map((r) => r.studentId),
    );
    const classes = await tx.classLevel.findMany({
      select: { id: true, sortOrder: true, isActive: true },
    });
    const next = nextClassLevel(classes, opts.classLevelId);
    const targets = [opts.classLevelId, ...(next ? [next.id] : [])];
    const toSections = await tx.section.findMany({
      where: { academicYearId: opts.toYearId, isActive: true, classLevelId: { in: targets } },
      select: { id: true, name: true, classLevelId: true },
    });
    const results = opts.meritExamId
      ? await this.results.results(opts.meritExamId, opts.classLevelId)
      : new Map<string, { passed: boolean; classPosition: number | null }>();

    return enrolments
      .filter((e) => !inRun.has(e.studentId))
      .map((e): NewRow => {
        const result = results.get(e.studentId) ?? null;
        const base = {
          studentId: e.studentId,
          fromEnrolmentId: e.id,
          fromSectionId: e.sectionId,
          fromRoll: e.roll,
          resultPassed: result?.passed ?? null,
          meritPosition: result?.classPosition ?? null,
        };
        const failed = result !== null && !result.passed;
        if (!next && !failed) {
          return {
            ...base,
            decision: 'LEAVE',
            targetClassLevelId: null,
            targetSectionId: null,
            targetStudyGroupId: null,
            leaveStatus: 'GRADUATED',
            leftOn: opts.fromYear.endDate,
          };
        }
        const target = failed ? opts.classLevelId : next!.id;
        const section = toSections.find(
          (s) => s.classLevelId === target && e.section !== null && s.name === e.section.name,
        );
        return {
          ...base,
          decision: failed ? 'REPEAT' : 'PROMOTE',
          targetClassLevelId: target,
          targetSectionId: section?.id ?? null,
          targetStudyGroupId: e.studyGroupId && e.studyGroup?.isActive ? e.studyGroupId : null,
          leaveStatus: null,
          leftOn: null,
        };
      });
  }

  private async insertRows(runId: string, toYearId: string, rows: NewRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.tx.promotionRunStudent.createMany({
      data: rows.map((r) => ({ ...r, tenantId: this.tenantId, runId, toYearId })),
    });
  }

  // ─────────────────────────── Changing ───────────────────────────

  /** The run, locked for the rest of the transaction (edits, refresh and apply take turns). */
  async lockRun(id: string) {
    const tx = this.db.tx;
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM promotion_runs WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundException('Promotion run not found');
    return tx.promotionRun.findUniqueOrThrow({ where: { id } });
  }

  private refuseWhileApplying(run: { status: string }) {
    if (run.status === 'APPLYING')
      throw apiError(409, 'RUN_APPLYING', 'This run is being applied; wait for it to finish');
  }

  /** Roll strategy and merit exam; a new exam takes the results of pending rows again. */
  async update(id: string, input: UpdatePromotionRunInput): Promise<PromotionRunDetail> {
    const tx = this.db.tx;
    const run = await this.lockRun(id);
    this.refuseWhileApplying(run);
    const examChanged = input.meritExamId !== undefined && input.meritExamId !== run.meritExamId;
    const merit = await this.meritChoice({
      examId: input.meritExamId !== undefined ? input.meritExamId : run.meritExamId,
      strategy: input.rollStrategy ?? run.rollStrategy,
      fromYearId: run.fromYearId,
      classLevelId: run.classLevelId,
      useDefault: false,
    });
    await tx.promotionRun.update({
      where: { id },
      data: { rollStrategy: merit.strategy, meritExamId: merit.examId },
    });
    let resnapshotted = 0;
    if (examChanged) {
      const results = merit.examId
        ? await this.results.results(merit.examId, run.classLevelId)
        : new Map<string, { passed: boolean; classPosition: number | null }>();
      const pending = await tx.promotionRunStudent.findMany({
        where: { runId: id, appliedAt: null },
        select: { id: true, studentId: true },
      });
      for (const row of pending) {
        const r = results.get(row.studentId);
        await tx.promotionRunStudent.updateMany({
          where: { id: row.id, appliedAt: null },
          data: { resultPassed: r?.passed ?? null, meritPosition: r?.classPosition ?? null },
        });
      }
      resnapshotted = pending.length;
    }
    await this.audit.record({
      entity: 'promotion_run',
      entityId: id,
      action: 'UPDATE',
      oldValues: { rollStrategy: run.rollStrategy, meritExamId: run.meritExamId },
      newValues: { rollStrategy: merit.strategy, meritExamId: merit.examId, resnapshotted },
    });
    return this.detail(id);
  }

  /**
   * Bulk edit of pending rows. PROMOTE goes to another active class, REPEAT stays in the run's
   * class; a section must be an active one of the to-year and of the target class; a group must
   * be active. Rows that break this answer 422 TARGET_INVALID with their ids (nothing is saved).
   */
  async editRows(id: string, edits: PromotionRowEdit[]): Promise<PromotionRunDetail> {
    const tx = this.db.tx;
    const run = await this.lockRun(id);
    this.refuseWhileApplying(run);
    const rows = await tx.promotionRunStudent.findMany({
      where: { runId: id, id: { in: edits.map((e) => e.id) } },
      select: { id: true, appliedAt: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = edits.filter((e) => !byId.has(e.id)).map((e) => e.id);
    if (missing.length > 0) throw new NotFoundException('Row not found in this run');
    const applied = rows.filter((r) => r.appliedAt).map((r) => r.id);
    if (applied.length > 0)
      throw apiError(409, 'ROW_APPLIED', 'Applied rows cannot be changed', { rowIds: applied });

    const classes = await tx.classLevel.findMany({ select: { id: true, isActive: true } });
    const sectionIds = [...new Set(edits.map((e) => e.targetSectionId).filter((s) => s !== null))];
    const sections = await tx.section.findMany({
      where: { id: { in: sectionIds } },
      select: { id: true, academicYearId: true, classLevelId: true, isActive: true },
    });
    const groupIds = [...new Set(edits.map((e) => e.targetStudyGroupId).filter((g) => g !== null))];
    const groups = await tx.studyGroup.findMany({
      where: { id: { in: groupIds } },
      select: { id: true, isActive: true },
    });
    const invalid: string[] = [];
    for (const e of edits) {
      if (e.decision === 'LEAVE') continue;
      const target = classes.find((c) => c.id === e.targetClassLevelId);
      const classOk =
        e.decision === 'REPEAT'
          ? e.targetClassLevelId === run.classLevelId
          : !!target && target.isActive && target.id !== run.classLevelId;
      const section = e.targetSectionId ? sections.find((s) => s.id === e.targetSectionId) : null;
      const sectionOk =
        !e.targetSectionId ||
        (!!section &&
          section.isActive &&
          section.academicYearId === run.toYearId &&
          section.classLevelId === e.targetClassLevelId);
      const group = e.targetStudyGroupId ? groups.find((g) => g.id === e.targetStudyGroupId) : null;
      const groupOk = !e.targetStudyGroupId || (!!group && group.isActive);
      if (!classOk || !sectionOk || !groupOk) invalid.push(e.id);
    }
    if (invalid.length > 0)
      throw apiError(422, 'TARGET_INVALID', 'Some rows have a target that does not fit', {
        rowIds: invalid,
      });

    for (const e of edits) {
      await tx.promotionRunStudent.updateMany({
        where: { id: e.id, runId: id, appliedAt: null },
        data: {
          decision: e.decision,
          targetClassLevelId: e.targetClassLevelId,
          targetSectionId: e.targetSectionId,
          targetStudyGroupId: e.targetStudyGroupId,
          leaveStatus: e.leaveStatus,
          leftOn: e.leftOn ? dateToDb(e.leftOn) : null,
          leaveReason: e.leaveReason,
        },
      });
    }
    await this.audit.record({
      entity: 'promotion_run',
      entityId: id,
      action: 'UPDATE',
      newValues: {
        step: 'rows',
        rows: edits.map((e) => ({
          id: e.id,
          decision: e.decision,
          targetClassLevelId: e.targetClassLevelId,
          targetSectionId: e.targetSectionId,
          targetStudyGroupId: e.targetStudyGroupId,
          leaveStatus: e.leaveStatus,
          leftOn: e.leftOn,
        })),
      },
    });
    return this.detail(id);
  }

  /**
   * Adds rows for students enrolled in the from-class since the run was made (and in no run into
   * the to-year), and removes pending rows of students who left or were deactivated meanwhile.
   */
  async refresh(id: string): Promise<PromotionRunDetail> {
    const tx = this.db.tx;
    const run = await this.lockRun(id);
    this.refuseWhileApplying(run);
    const removed = await tx.promotionRunStudent.deleteMany({
      where: {
        runId: id,
        appliedAt: null,
        student: { OR: [{ deletedAt: { not: null } }, { status: { not: 'ACTIVE' } }] },
      },
    });
    const fromYear = await this.year(run.fromYearId);
    const rows = await this.newRows({
      fromYear,
      toYearId: run.toYearId,
      classLevelId: run.classLevelId,
      meritExamId: run.meritExamId,
    });
    await this.insertRows(id, run.toYearId, rows);
    await this.audit.record({
      entity: 'promotion_run',
      entityId: id,
      action: 'UPDATE',
      newValues: { step: 'refresh', added: rows.length, removed: removed.count },
    });
    return this.detail(id);
  }
}

function emptyCounts(): PromotionRunCounts {
  return {
    total: 0,
    promote: 0,
    repeat: 0,
    leave: 0,
    pending: 0,
    withoutSection: 0,
    noResult: 0,
  };
}

function toSummary(r: RunRow, counts: PromotionRunCounts): PromotionRunSummary {
  return {
    id: r.id,
    fromYear: r.fromYear,
    toYear: r.toYear,
    classLevel: r.classLevel,
    rollStrategy: r.rollStrategy,
    meritExam: r.meritExam,
    status: r.status,
    lastError: r.lastError,
    applyStartedAt: r.applyStartedAt?.toISOString() ?? null,
    appliedAt: r.appliedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    counts,
  };
}

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import {
  computeClassResults,
  dateFromDb,
  formatMarks,
  toCsv,
  type ClassResults,
  type GradeBand,
  type GradeBandView,
  type MarkEntry,
  type MeritKey,
  type PublishCheck,
  type RemarksView,
  type ReportCard,
  type ReportCards,
  type ResultRow,
  type SaveRemarksInput,
  type Tabulation,
} from '@jantrik/shared';
import { AttendanceStatsService } from '../../attendance/attendance-stats.service.js';
import { AuditService } from '../../audit/audit.module.js';
import { apiError } from '../../common/api-error.js';
import { RequestContext } from '../../common/request-context.js';
import { StudentAccess } from '../../students/student-access.service.js';
import { Db } from '../../tenancy/db.service.js';
import { TenantAccessService } from '../../tenancy/tenant-access.service.js';
import { ExamAccessService, type ExamCaller } from '../exam-access.service.js';
import { ExamRosterService } from '../marks/exam-roster.service.js';
import { ExamService } from '../structure/exam.service.js';

const subjectRef = { select: { id: true, code: true, nameBn: true, nameEn: true } } as const;

/** One subject in the published snapshot (exam_results.subjects). */
interface SnapshotSubject {
  examSubjectId: string;
  subjectId: string;
  optional: boolean;
  status: 'COMPLETE' | 'INCOMPLETE' | 'ABSENT';
  obtainedH: number;
  fullMarks: number;
  letter: string | null;
  gradePoint: number | null;
  passed: boolean;
  marks: Record<string, MarkEntry>;
}

type ClassContext = Awaited<ReturnType<ExamResultsService['classContext']>>;

/**
 * Results (docs/exams.md): a class's results are computed from its marks with the shared rules
 * (computeClassResults). Before publish the tabulation is a live preview; publishing stores a
 * snapshot (exam_results) and bumps the class's version, so guardians, report cards and SMS read
 * exactly what was published. Changes after that show as "stale" until republished.
 */
@Injectable()
export class ExamResultsService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly access: ExamAccessService,
    private readonly exams: ExamService,
    private readonly roster: ExamRosterService,
    private readonly studentAccess: StudentAccess,
    private readonly attendance: AttendanceStatsService,
    private readonly tenantAccess: TenantAccessService,
  ) {}

  private get tenantId(): string {
    return this.context.requirePrincipal().tenantId!;
  }

  // ─────────────────────────── Publish ───────────────────────────

  async publishCheck(examId: string, examClassId: string): Promise<PublishCheck> {
    const caller = await this.access.caller();
    if (!caller.isAdmin) throw new ForbiddenException();
    const ctx = await this.classContext(examId, examClassId);
    const live = await this.computeLive(ctx);
    return this.check(ctx, live);
  }

  /**
   * Publish (or republish) one class: every sheet with students locked, every student complete.
   * Locks: the exam row FOR SHARE, then the exam class FOR UPDATE (sheet writes hold it FOR
   * SHARE), so no mark changes while the snapshot is written. `baseVersion` must be the version
   * the admin saw (409 PUBLISH_CHANGED otherwise).
   */
  async publish(examId: string, examClassId: string, baseVersion: number): Promise<PublishCheck> {
    const caller = await this.access.caller();
    if (!caller.isAdmin) throw new ForbiddenException();
    const tx = this.db.tx;
    await tx.$queryRaw`SELECT id FROM exams WHERE id = ${examId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM exam_classes WHERE id = ${examClassId}::uuid FOR UPDATE`;
    const ctx = await this.classContext(examId, examClassId);
    if (ctx.exam.status === 'SETUP') throw apiError(409, 'NOT_OPEN', 'The exam is not open yet');
    if (ctx.examClass.publishedVersion !== baseVersion) {
      throw apiError(409, 'PUBLISH_CHANGED', 'The results were published meanwhile', {
        publishedVersion: ctx.examClass.publishedVersion,
      });
    }
    const live = await this.computeLive(ctx);
    const check = await this.check(ctx, live);
    if (check.blockers.unlockedSheets.length > 0 || check.blockers.incompleteStudents > 0) {
      throw apiError(409, 'NOT_READY', 'Lock every sheet and complete every student first', {
        blockers: check.blockers,
      });
    }
    const version = ctx.examClass.publishedVersion + 1;
    const attendance = await this.attendanceFor(
      ctx,
      live.outcome.students.map((s) => s.studentId),
    );
    const remarks = new Map(live.candidates.map((c) => [c.studentId, c.remarks]));
    const tenantId = this.tenantId;
    await tx.examResult.deleteMany({ where: { examClassId } });
    await tx.examResult.createMany({
      data: live.outcome.students.map((s) => {
        const att = attendance?.get(s.studentId);
        const attTotal = att
          ? att.counts.present + att.counts.absent + att.counts.late + att.counts.leave
          : null;
        return {
          tenantId,
          examId,
          examClassId,
          classLevelId: ctx.examClass.classLevelId,
          studentId: s.studentId,
          sectionId: s.sectionId,
          roll: s.roll,
          totalH: s.result.totalH,
          fullMarks: s.result.fullMarks,
          percentH: s.result.percentH,
          gpaH: s.result.gpaH,
          gpaWithoutOptionalH: s.result.gpaWithoutOptionalH,
          letter: s.result.letter,
          passed: s.result.passed,
          failedSubjects: s.result.failedSubjects,
          classPosition: s.classPosition,
          sectionPosition: s.sectionPosition,
          attendancePresent: att ? att.counts.present + att.counts.late : null,
          attendanceTotal: attTotal,
          attendancePercentH: att && att.percent !== null ? Math.round(att.percent * 100) : null,
          remarks: remarks.get(s.studentId) ?? null,
          subjects: s.subjects.map((x): SnapshotSubject => ({
            examSubjectId: x.examSubjectId,
            subjectId: x.subjectId,
            optional: x.optional,
            status: x.result.status,
            obtainedH: x.result.obtainedH,
            fullMarks: x.result.fullMarks,
            letter: x.result.letter,
            gradePoint: x.result.gradePoint,
            passed: x.result.passed,
            marks: x.marks,
          })) as unknown as Prisma.InputJsonValue,
          publishedVersion: version,
        };
      }),
    });
    const now = new Date();
    await tx.examClass.update({
      where: { id: examClassId },
      data: {
        isPublished: true,
        publishedVersion: version,
        publishedAt: now,
        publishedById: caller.userId,
        unpublishedReason: null,
        gradingSnapshot: ctx.scheme
          ? ({
              schemeId: ctx.scheme.id,
              roundingMode: ctx.scheme.roundingMode,
              bands: ctx.bandViews,
              rules: ctx.rules,
            } as unknown as Prisma.InputJsonValue)
          : undefined,
        subjectStats: live.outcome.subjectStats as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.record({
      entity: 'exam_classes',
      entityId: examClassId,
      action: 'UPDATE',
      oldValues: { publishedVersion: ctx.examClass.publishedVersion },
      newValues: {
        action: 'PUBLISH',
        publishedVersion: version,
        students: live.outcome.students.length,
      },
    });
    return this.check(await this.classContext(examId, examClassId), live);
  }

  async unpublish(examId: string, examClassId: string, reason: string): Promise<PublishCheck> {
    const caller = await this.access.caller();
    if (!caller.isAdmin) throw new ForbiddenException();
    const tx = this.db.tx;
    await tx.$queryRaw`SELECT id FROM exam_classes WHERE id = ${examClassId}::uuid FOR UPDATE`;
    const ctx = await this.classContext(examId, examClassId);
    if (!ctx.examClass.isPublished)
      throw apiError(409, 'NOT_PUBLISHED', 'The results are not published');
    await tx.examClass.update({
      where: { id: examClassId },
      data: { isPublished: false, unpublishedReason: reason },
    });
    await this.audit.record({
      entity: 'exam_classes',
      entityId: examClassId,
      action: 'UPDATE',
      oldValues: { isPublished: true, publishedVersion: ctx.examClass.publishedVersion },
      newValues: { action: 'UNPUBLISH', reason },
    });
    const fresh = await this.classContext(examId, examClassId);
    return this.check(fresh, await this.computeLive(fresh));
  }

  // ─────────────────────────── Tabulation ───────────────────────────

  async tabulation(examId: string, examClassId: string, sectionId?: string): Promise<Tabulation> {
    const caller = await this.access.caller();
    await this.assertSectionReader(caller, sectionId);
    const ctx = await this.classContext(examId, examClassId);
    const live = await this.computeLive(ctx);
    const sections = await this.sectionNames(ctx);
    let rows: ResultRow[];
    if (ctx.examClass.isPublished) {
      const published = await this.db.tx.examResult.findMany({
        where: { examClassId, ...(sectionId ? { sectionId } : {}) },
        include: {
          candidate: {
            select: { student: { select: { studentCode: true, nameBn: true, nameEn: true } } },
          },
        },
      });
      rows = published.map((r) => ({
        studentId: r.studentId,
        studentCode: r.candidate.student.studentCode,
        nameBn: r.candidate.student.nameBn,
        nameEn: r.candidate.student.nameEn,
        roll: r.roll,
        section: { id: r.sectionId, name: sections.get(r.sectionId) ?? '' },
        subjects: (r.subjects as unknown as SnapshotSubject[]).map(toCell),
        totalH: r.totalH,
        fullMarks: r.fullMarks,
        percentH: r.percentH,
        gpaH: r.gpaH,
        gpaWithoutOptionalH: r.gpaWithoutOptionalH,
        letter: r.letter,
        passed: r.passed,
        failedSubjects: r.failedSubjects,
        classPosition: r.classPosition,
        sectionPosition: r.sectionPosition,
        complete: true,
      }));
    } else {
      const info = new Map(live.candidates.map((c) => [c.studentId, c]));
      rows = live.outcome.students
        .filter((s) => !sectionId || s.sectionId === sectionId)
        .map((s) => {
          const c = info.get(s.studentId)!;
          return {
            studentId: s.studentId,
            studentCode: c.studentCode,
            nameBn: c.nameBn,
            nameEn: c.nameEn,
            roll: s.roll,
            section: { id: s.sectionId, name: sections.get(s.sectionId) ?? '' },
            subjects: s.subjects.map((x) =>
              toCell({
                examSubjectId: x.examSubjectId,
                subjectId: x.subjectId,
                optional: x.optional,
                status: x.result.status,
                obtainedH: x.result.obtainedH,
                fullMarks: x.result.fullMarks,
                letter: x.result.letter,
                gradePoint: x.result.gradePoint,
                passed: x.result.passed,
                marks: x.marks,
              }),
            ),
            totalH: s.result.totalH,
            fullMarks: s.result.fullMarks,
            percentH: s.result.percentH,
            gpaH: s.result.gpaH,
            gpaWithoutOptionalH: s.result.gpaWithoutOptionalH,
            letter: s.result.letter,
            passed: s.result.passed,
            failedSubjects: s.result.failedSubjects,
            classPosition: s.classPosition,
            sectionPosition: s.sectionPosition,
            complete: s.result.complete,
          };
        });
    }
    rows.sort(
      (a, b) =>
        (a.classPosition ?? Number.MAX_SAFE_INTEGER) -
          (b.classPosition ?? Number.MAX_SAFE_INTEGER) || (a.roll ?? 0) - (b.roll ?? 0),
    );
    return {
      exam: {
        id: ctx.exam.id,
        nameBn: ctx.exam.nameBn,
        nameEn: ctx.exam.nameEn,
        resultMode: ctx.exam.resultMode,
      },
      classLevel: ctx.classLevel,
      section: sectionId ? { id: sectionId, name: sections.get(sectionId) ?? '' } : null,
      source: ctx.examClass.isPublished ? 'PUBLISHED' : 'PREVIEW',
      publishedVersion: ctx.examClass.publishedVersion,
      stale: await this.isStale(ctx),
      gpaDecimals: ctx.rules.gpaDecimals,
      subjects: ctx.subjects.map((s) => ({
        examSubjectId: s.id,
        subject: s.subject,
        fullMarks: s.components.reduce((n, c) => n + c.fullMarks, 0),
        components: s.components.map((c) => ({
          key: c.key,
          kind: c.kind,
          nameBn: c.nameBn,
          nameEn: c.nameEn,
          fullMarks: c.fullMarks,
          passMarks: c.passMarks,
        })),
      })),
      rows,
    };
  }

  /** The tabulation as CSV: ASCII digits, no guardian data (decision #19). */
  async tabulationCsv(
    examId: string,
    examClassId: string,
    sectionId: string | undefined,
    locale: 'bn' | 'en',
  ): Promise<{ filename: string; csv: string }> {
    const t = await this.tabulation(examId, examClassId, sectionId);
    const L = CSV_LABELS[locale];
    const gpa = t.exam.resultMode === 'GPA';
    const name = (x: { nameBn: string | null; nameEn: string | null }) =>
      locale === 'bn' ? (x.nameBn ?? x.nameEn ?? '') : (x.nameEn ?? x.nameBn ?? '');
    const header = [
      L.position,
      L.roll,
      L.section,
      L.id,
      L.name,
      ...t.subjects.flatMap((s) =>
        gpa ? [s.subject.code, `${s.subject.code} ${L.grade}`] : [s.subject.code],
      ),
      L.total,
      L.percent,
      ...(gpa ? [L.gpa, L.grade] : []),
      L.result,
    ];
    const body = t.rows.map((r) => [
      r.classPosition,
      r.roll,
      r.section.name,
      r.studentCode,
      name(r),
      ...t.subjects.flatMap((s) => {
        const cell = r.subjects.find((x) => x.examSubjectId === s.examSubjectId);
        const marks = cell
          ? cell.status === 'ABSENT'
            ? L.absent
            : formatMarks(cell.obtainedH, 'en')
          : '';
        return gpa ? [marks, cell?.letter ?? ''] : [marks];
      }),
      formatMarks(r.totalH, 'en'),
      formatMarks(r.percentH, 'en'),
      ...(gpa
        ? [r.gpaH === null ? '' : (r.gpaH / 100).toFixed(t.gpaDecimals), r.letter ?? '']
        : []),
      r.complete ? (r.passed ? L.pass : L.fail) : '',
    ]);
    return {
      filename: `tabulation-${t.classLevel.code}${t.section ? `-${t.section.id.slice(0, 8)}` : ''}.csv`,
      csv: toCsv([header, ...body]),
    };
  }

  // ─────────────────────────── Report cards ───────────────────────────

  /** Published report cards of a section, or of one student (staff). */
  async reportCards(
    examId: string,
    filter: { sectionId?: string; studentId?: string },
  ): Promise<ReportCards> {
    const caller = await this.access.caller();
    const tx = this.db.tx;
    await this.exams.detail(examId);
    const where = {
      examId,
      examClass: { isPublished: true },
      ...(filter.sectionId ? { sectionId: filter.sectionId } : {}),
      ...(filter.studentId ? { studentId: filter.studentId } : {}),
    };
    const first = await tx.examResult.findFirst({
      where,
      select: { examClassId: true, sectionId: true },
    });
    if (!first) throw new NotFoundException('No published results');
    await this.assertSectionReader(caller, first.sectionId);
    if (filter.sectionId && filter.sectionId !== first.sectionId) throw new NotFoundException();
    return this.buildCards(first.examClassId, where, { asGuardian: false });
  }

  /** A guardian's own child's published report card (the caller is checked by the caller). */
  async childReportCard(examClassId: string, studentId: string): Promise<ReportCards> {
    const where = { examClassId, studentId, examClass: { isPublished: true } };
    const found = await this.db.tx.examResult.findFirst({ where, select: { id: true } });
    if (!found) throw new NotFoundException('No published result');
    return this.buildCards(examClassId, where, { asGuardian: true });
  }

  private async buildCards(
    examClassId: string,
    where: Prisma.ExamResultWhereInput,
    opts: { asGuardian: boolean },
  ): Promise<ReportCards> {
    const tx = this.db.tx;
    const examClass = await tx.examClass.findUniqueOrThrow({
      where: { id: examClassId },
      include: {
        classLevel: subjectRef,
        exam: { include: { tenant: { select: { name: true } } } },
        subjects: {
          orderBy: { sortOrder: 'asc' },
          include: { subject: subjectRef, components: { orderBy: { sortOrder: 'asc' } } },
        },
      },
    });
    const results = await tx.examResult.findMany({
      where,
      orderBy: [{ roll: 'asc' }],
      include: {
        section: { select: { id: true, name: true } },
        candidate: {
          select: {
            studyGroup: subjectRef,
            student: {
              select: {
                id: true,
                studentCode: true,
                nameBn: true,
                nameEn: true,
                photoUrl: true,
                fatherNameBn: true,
                fatherNameEn: true,
                motherNameBn: true,
                motherNameEn: true,
                enrolments: {
                  where: { academicYear: { isCurrent: true } },
                  select: { sectionId: true },
                },
              },
            },
          },
        },
      },
    });
    const classSize = await tx.examResult.count({ where: { examClassId } });
    const scope = opts.asGuardian ? null : await this.studentAccess.scope();
    const stats = (examClass.subjectStats ?? {}) as Record<string, { highestH: number }>;
    const snapshot = examClass.gradingSnapshot as {
      bands: GradeBandView[];
      rules: { gpaDecimals: number; gpaMax: number; optionalBonusAbove: number | null };
    } | null;
    const exam = examClass.exam;
    const cards: ReportCard[] = results.map((r) => {
      const st = r.candidate.student;
      const sees =
        opts.asGuardian ||
        (scope && StudentAccess.sees(scope, st.enrolments[0]?.sectionId ?? null));
      const subjects = r.subjects as unknown as SnapshotSubject[];
      return {
        student: {
          id: st.id,
          studentCode: st.studentCode,
          nameBn: st.nameBn,
          nameEn: st.nameEn,
          photoUrl: st.photoUrl,
          fatherNameBn: sees ? st.fatherNameBn : null,
          fatherNameEn: sees ? st.fatherNameEn : null,
          motherNameBn: sees ? st.motherNameBn : null,
          motherNameEn: sees ? st.motherNameEn : null,
        },
        section: r.section,
        studyGroup: r.candidate.studyGroup,
        roll: r.roll,
        subjects: subjects.map((x) => {
          const es = examClass.subjects.find((s) => s.id === x.examSubjectId);
          return {
            subject: es?.subject ?? { id: x.subjectId, code: '', nameBn: '', nameEn: '' },
            optional: x.optional,
            status: x.status,
            components: (es?.components ?? []).map((c) => ({
              key: c.key,
              nameBn: c.nameBn,
              nameEn: c.nameEn,
              fullMarks: c.fullMarks,
              mark: x.marks[c.key] ?? null,
            })),
            obtainedH: x.obtainedH,
            fullMarks: x.fullMarks,
            letter: x.letter,
            gradePoint: x.gradePoint,
            passed: x.passed,
            highestH: stats[x.examSubjectId]?.highestH ?? null,
          };
        }),
        totalH: r.totalH,
        fullMarks: r.fullMarks,
        percentH: r.percentH,
        gpaH: r.gpaH,
        gpaWithoutOptionalH: r.gpaWithoutOptionalH,
        letter: r.letter,
        passed: r.passed,
        failedSubjects: r.failedSubjects,
        classPosition: r.classPosition,
        sectionPosition: r.sectionPosition,
        classSize,
        attendance:
          r.attendanceTotal !== null && r.attendancePresent !== null
            ? {
                present: r.attendancePresent,
                total: r.attendanceTotal,
                percentH: r.attendancePercentH,
              }
            : null,
        remarks: r.remarks,
      };
    });
    return {
      institute: { name: exam.tenant.name },
      exam: {
        id: exam.id,
        nameBn: exam.nameBn,
        nameEn: exam.nameEn,
        kind: exam.kind,
        resultMode: exam.resultMode,
        startsOn: dateFromDb(exam.startsOn),
        endsOn: dateFromDb(exam.endsOn),
        attendance:
          exam.attendanceFrom && exam.attendanceTo
            ? { from: dateFromDb(exam.attendanceFrom), to: dateFromDb(exam.attendanceTo) }
            : null,
      },
      classLevel: examClass.classLevel,
      publishedVersion: examClass.publishedVersion,
      publishedAt: examClass.publishedAt!.toISOString(),
      grading:
        exam.resultMode === 'GPA' && snapshot
          ? {
              bands: snapshot.bands,
              gpaDecimals: snapshot.rules.gpaDecimals,
              gpaMax: snapshot.rules.gpaMax,
              optionalBonusAbove: snapshot.rules.optionalBonusAbove,
            }
          : null,
      cards,
    };
  }

  // ─────────────────────────── Remarks ───────────────────────────

  async remarks(examId: string, sectionId: string): Promise<RemarksView> {
    const caller = await this.access.caller();
    await this.assertClassTeacher(caller, sectionId);
    return this.remarksView(examId, sectionId);
  }

  /** The class teacher writes remarks before publish; after it only an admin (then: republish). */
  async saveRemarks(examId: string, input: SaveRemarksInput): Promise<RemarksView> {
    const caller = await this.access.caller();
    await this.assertClassTeacher(caller, input.sectionId);
    const tx = this.db.tx;
    await tx.$queryRaw`SELECT id FROM exams WHERE id = ${examId}::uuid FOR SHARE`;
    const before = await this.remarksView(examId, input.sectionId);
    if (before.isPublished && !caller.isAdmin) {
      throw apiError(403, 'PUBLISHED', 'Results are published: ask the office to change remarks');
    }
    const known = new Map(before.students.map((s) => [s.studentId, s.remarks]));
    const changed = input.remarks.filter(
      (r) => known.has(r.studentId) && (known.get(r.studentId) ?? '') !== r.text,
    );
    if (input.remarks.some((r) => !known.has(r.studentId))) {
      throw apiError(422, 'UNKNOWN_STUDENT', 'A student is not in this section for this exam');
    }
    const now = new Date();
    for (const r of changed) {
      await tx.examCandidate.update({
        where: {
          tenantId_examId_studentId: { tenantId: this.tenantId, examId, studentId: r.studentId },
        },
        data: { remarks: r.text || null, remarksById: caller.userId, remarksAt: now },
      });
    }
    if (changed.length > 0) {
      await this.audit.record({
        entity: 'exam_remarks',
        entityId: input.sectionId,
        action: 'UPDATE',
        oldValues: changed.map((r) => ({
          studentId: r.studentId,
          remarks: known.get(r.studentId) ?? null,
        })),
        newValues: {
          examId,
          remarks: changed.map((r) => ({ studentId: r.studentId, remarks: r.text || null })),
        },
      });
    }
    return this.remarksView(examId, input.sectionId);
  }

  private async remarksView(examId: string, sectionId: string): Promise<RemarksView> {
    const tx = this.db.tx;
    await this.exams.detail(examId);
    const section = await tx.section.findUnique({
      where: { id: sectionId },
      select: { id: true, name: true, classLevelId: true },
    });
    if (!section) throw new NotFoundException('Section not found');
    const examClass = await tx.examClass.findFirst({
      where: { examId, classLevelId: section.classLevelId },
      select: { isPublished: true },
    });
    if (!examClass) throw new NotFoundException('The exam does not cover this section');
    const candidates = await tx.examCandidate.findMany({
      where: { examId, sectionId, status: 'ENROLLED' },
      orderBy: [{ roll: 'asc' }],
      select: {
        studentId: true,
        roll: true,
        remarks: true,
        student: { select: { studentCode: true, nameBn: true, nameEn: true } },
      },
    });
    return {
      section: { id: section.id, name: section.name },
      isPublished: examClass.isPublished,
      students: candidates.map((c) => ({
        studentId: c.studentId,
        studentCode: c.student.studentCode,
        nameBn: c.student.nameBn,
        nameEn: c.student.nameEn,
        roll: c.roll,
        remarks: c.remarks,
      })),
    };
  }

  // ─────────────────────────── Helpers ───────────────────────────

  async classContext(examId: string, examClassId: string) {
    const tx = this.db.tx;
    await this.exams.detail(examId);
    const examClass = await tx.examClass.findFirst({
      where: { id: examClassId, examId },
      include: {
        classLevel: {
          select: { id: true, code: true, nameBn: true, nameEn: true, gradingSchemeId: true },
        },
      },
    });
    if (!examClass) throw new NotFoundException('Exam class not found');
    const exam = await tx.exam.findUniqueOrThrow({ where: { id: examId } });
    const subjects = await tx.examSubject.findMany({
      where: { examClassId },
      orderBy: { sortOrder: 'asc' },
      include: {
        subject: subjectRef,
        components: { orderBy: { sortOrder: 'asc' } },
        passGroups: true,
      },
    });
    const scheme = await tx.gradingScheme.findFirst({
      where: examClass.classLevel.gradingSchemeId
        ? { id: examClass.classLevel.gradingSchemeId }
        : { isDefault: true },
      include: { bands: { orderBy: { minPercent: 'desc' } } },
    });
    const bands: GradeBand[] =
      scheme?.bands.map((b) => ({
        minPercent: b.minPercent.toNumber(),
        letter: b.letter,
        gradePoint: b.gradePoint.toNumber(),
      })) ?? [];
    const bandViews: GradeBandView[] =
      scheme?.bands.map((b) => ({
        minPercent: b.minPercent.toNumber(),
        maxPercent: b.maxPercent.toNumber(),
        letter: b.letter,
        gradePoint: b.gradePoint.toNumber(),
      })) ?? [];
    const rules = {
      gpaMax: scheme?.gpaMax.toNumber() ?? 5,
      optionalBonusAbove: scheme?.optionalBonusAbove?.toNumber() ?? null,
      gpaDecimals: scheme?.gpaDecimals ?? 2,
      gpaRounding: scheme?.gpaRounding ?? 'TRUNCATE',
      compulsoryFailZero: scheme?.compulsoryFailZero ?? true,
    };
    const { gradingSchemeId: _g, ...classLevel } = examClass.classLevel;
    return { exam, examClass, classLevel, subjects, scheme, bands, bandViews, rules };
  }

  private async computeLive(ctx: ClassContext): Promise<{
    candidates: (Awaited<ReturnType<ExamRosterService['candidates']>>[number] & {
      remarks: string | null;
    })[];
    outcome: ClassResults;
  }> {
    const tx = this.db.tx;
    const roster = await this.roster.candidates(ctx.exam.id, ctx.examClass.classLevelId);
    const remarks = await tx.examCandidate.findMany({
      where: { examId: ctx.exam.id, classLevelId: ctx.examClass.classLevelId },
      select: { studentId: true, remarks: true },
    });
    const remarkOf = new Map(remarks.map((r) => [r.studentId, r.remarks]));
    const rows = await tx.examMark.findMany({
      where: { examSubjectId: { in: ctx.subjects.map((s) => s.id) } },
      select: {
        examSubjectId: true,
        studentId: true,
        scoreH: true,
        absent: true,
        component: { select: { key: true } },
      },
    });
    const marks = new Map<string, Record<string, MarkEntry>>();
    for (const m of rows) {
      const k = `${m.examSubjectId}:${m.studentId}`;
      const rec = marks.get(k) ?? {};
      if (m.absent || m.scoreH !== null)
        rec[m.component.key] = { scoreH: m.scoreH, absent: m.absent };
      marks.set(k, rec);
    }
    const outcome = computeClassResults({
      mode: ctx.exam.resultMode,
      bands: ctx.bands,
      roundingMode: ctx.scheme?.roundingMode ?? 'NONE',
      rules: ctx.rules,
      meritOrder: ctx.exam.meritOrder as MeritKey[],
      failedRanking: ctx.exam.failedRanking,
      subjects: ctx.subjects.map((s) => ({
        examSubjectId: s.id,
        subjectId: s.subjectId,
        studyGroupId: s.studyGroupId,
        isElective: s.isElective,
        passRule: s.passRule,
        components: s.components.map((c) => ({
          key: c.key,
          kind: c.kind,
          fullMarks: c.fullMarks,
          passMarks: c.passMarks,
        })),
        passGroups: s.passGroups.map((g) => ({ kind: g.kind, passMarks: g.passMarks })),
      })),
      candidates: roster.map((c) => ({
        studentId: c.studentId,
        sectionId: c.sectionId,
        roll: c.roll,
        studyGroupId: c.studyGroupId,
        choices: c.choices,
      })),
      marks,
    });
    return {
      candidates: roster.map((c) => ({ ...c, remarks: remarkOf.get(c.studentId) ?? null })),
      outcome,
    };
  }

  private async check(
    ctx: ClassContext,
    live: Awaited<ReturnType<ExamResultsService['computeLive']>>,
  ): Promise<PublishCheck> {
    const tx = this.db.tx;
    const sheets = await tx.examMarkSheet.findMany({
      where: { examSubjectId: { in: ctx.subjects.map((s) => s.id) } },
      select: { examSubjectId: true, sectionId: true, status: true },
    });
    const sections = await this.sectionNames(ctx);
    const unlocked: PublishCheck['blockers']['unlockedSheets'] = [];
    for (const s of ctx.subjects) {
      const sectionIds = new Set(
        live.outcome.students
          .filter((st) => st.subjects.some((x) => x.examSubjectId === s.id))
          .map((st) => st.sectionId),
      );
      for (const sectionId of sectionIds) {
        const sheet = sheets.find((x) => x.examSubjectId === s.id && x.sectionId === sectionId);
        if (sheet?.status !== 'LOCKED') {
          unlocked.push({
            examSubjectId: s.id,
            subject: s.subject,
            section: { id: sectionId, name: sections.get(sectionId) ?? '' },
            status: sheet?.status ?? 'DRAFT',
          });
        }
      }
    }
    const drift = await this.exams.rosterDrift(ctx.exam.id, ctx.examClass.classLevelId);
    const pools = new Set(
      ctx.subjects.filter((s) => s.isElective).map((s) => s.studyGroupId ?? '*'),
    );
    const missingChoices = live.candidates.filter(
      (c) => (pools.has('*') || pools.has(c.studyGroupId ?? '')) && c.choices.length === 0,
    ).length;
    return {
      examClassId: ctx.examClass.id,
      isPublished: ctx.examClass.isPublished,
      publishedVersion: ctx.examClass.publishedVersion,
      publishedAt: ctx.examClass.publishedAt?.toISOString() ?? null,
      stale: await this.isStale(ctx),
      blockers: { unlockedSheets: unlocked, incompleteStudents: live.outcome.incomplete.length },
      warnings: { rosterChanges: drift, missingChoices },
      students: live.outcome.students.length,
    };
  }

  /** Marks or remarks changed after the last publish. */
  private async isStale(ctx: ClassContext): Promise<boolean> {
    const at = ctx.examClass.publishedAt;
    if (!ctx.examClass.isPublished || !at) return false;
    const tx = this.db.tx;
    const [sheet, remark] = await Promise.all([
      tx.examMarkSheet.findFirst({
        where: { examSubjectId: { in: ctx.subjects.map((s) => s.id) }, updatedAt: { gt: at } },
        select: { id: true },
      }),
      tx.examCandidate.findFirst({
        where: {
          examId: ctx.exam.id,
          classLevelId: ctx.examClass.classLevelId,
          remarksAt: { gt: at },
        },
        select: { id: true },
      }),
    ]);
    return !!sheet || !!remark;
  }

  private async attendanceFor(ctx: ClassContext, studentIds: string[]) {
    if (!ctx.exam.attendanceFrom || !ctx.exam.attendanceTo) return null;
    const modules = await this.tenantAccess.getEnabledModules(this.tenantId);
    if (!modules.includes('ATTENDANCE')) return null;
    return this.attendance.percentByStudent(
      studentIds,
      dateFromDb(ctx.exam.attendanceFrom),
      dateFromDb(ctx.exam.attendanceTo),
    );
  }

  private async sectionNames(ctx: ClassContext): Promise<Map<string, string>> {
    const rows = await this.db.tx.section.findMany({
      where: { academicYearId: ctx.exam.academicYearId, classLevelId: ctx.examClass.classLevelId },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** Admins read every section; a teacher of the section (section_teachers) reads that one. */
  private async assertSectionReader(
    caller: ExamCaller,
    sectionId: string | undefined,
  ): Promise<void> {
    if (caller.isAdmin) return;
    if (!sectionId) throw new ForbiddenException('Pick your section');
    const row = await this.db.tx.sectionTeacher.findFirst({
      where: { sectionId, userId: caller.userId },
      select: { id: true },
    });
    if (!row) throw apiError(403, 'NOT_ASSIGNED', 'You do not teach this section');
  }

  private async assertClassTeacher(caller: ExamCaller, sectionId: string): Promise<void> {
    if (caller.isAdmin) return;
    const row = await this.db.tx.sectionTeacher.findFirst({
      where: { sectionId, userId: caller.userId, isClassTeacher: true },
      select: { id: true },
    });
    if (!row) throw apiError(403, 'NOT_CLASS_TEACHER', 'Only the class teacher writes remarks');
  }
}

const toCell = (x: SnapshotSubject) => ({
  examSubjectId: x.examSubjectId,
  optional: x.optional,
  status: x.status,
  obtainedH: x.obtainedH,
  fullMarks: x.fullMarks,
  letter: x.letter,
  gradePoint: x.gradePoint,
  passed: x.passed,
  marks: x.marks,
});

const CSV_LABELS = {
  bn: {
    position: 'মেধাক্রম',
    roll: 'রোল',
    section: 'শাখা',
    id: 'আইডি',
    name: 'নাম',
    grade: 'গ্রেড',
    total: 'মোট',
    percent: 'শতাংশ',
    gpa: 'জিপিএ',
    result: 'ফলাফল',
    pass: 'পাস',
    fail: 'ফেল',
    absent: 'অনুপস্থিত',
  },
  en: {
    position: 'Position',
    roll: 'Roll',
    section: 'Section',
    id: 'ID',
    name: 'Name',
    grade: 'Grade',
    total: 'Total',
    percent: 'Percent',
    gpa: 'GPA',
    result: 'Result',
    pass: 'Pass',
    fail: 'Fail',
    absent: 'Absent',
  },
} as const;

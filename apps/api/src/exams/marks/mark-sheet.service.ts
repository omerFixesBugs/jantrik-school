import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  parseMarks,
  type CorrectMarksInput,
  type ExamSheetsGrid,
  type LockAllResult,
  type MarkCell,
  type MarkSheetHistoryEntry,
  type MarkSheetView,
  type MySheet,
  type SaveMarkSheetInput,
  type SaveMarkSheetResult,
} from '@jantrik/shared';
import { AuditService } from '../../audit/audit.module.js';
import { apiError } from '../../common/api-error.js';
import { RequestContext } from '../../common/request-context.js';
import { staffNames, staffRef } from '../../staff/staff.module.js';
import { Db } from '../../tenancy/db.service.js';
import { ExamAccessService, type ExamCaller } from '../exam-access.service.js';
import { ExamService } from '../structure/exam.service.js';
import { ExamRosterService, sits, type RosterStudent } from './exam-roster.service.js';

type Action = MarkSheetHistoryEntry['action'];
type Change = MarkSheetHistoryEntry['changes'][number];

const BLANK: MarkCell = { scoreH: null, absent: false };
const cellOf = (m: { scoreH: number | null; absent: boolean } | undefined): MarkCell | null =>
  m && (m.absent || m.scoreH !== null) ? { scoreH: m.scoreH, absent: m.absent } : null;
const sameCell = (a: MarkCell | null, b: MarkCell | null) =>
  (a?.scoreH ?? null) === (b?.scoreH ?? null) && (a?.absent ?? false) === (b?.absent ?? false);
const filled = (c: MarkCell | null) => !!c && (c.absent || c.scoreH !== null);
/** Changes as plain JSON for audit_logs. */
const auditChanges = (changes: Change[]) =>
  changes.map((c) => ({
    studentId: c.studentId,
    key: c.key,
    from: c.from ? { scoreH: c.from.scoreH, absent: c.from.absent } : null,
    to: { scoreH: c.to.scoreH, absent: c.to.absent },
  }));

/**
 * Marks entry (docs/exams.md). A subject teacher enters marks only for the subjects given to them
 * in their sections (section_subject_teachers); OWNER/ADMIN for any. A sheet is saved whole, safely
 * (submissionId replay, baseVersion conflicts, like an attendance register); SUBMIT needs every
 * cell; editing a submitted sheet makes it a draft again. LOCKED sheets change only through an
 * admin's correction with a reason. Every change is audited with the cells that changed.
 */
@Injectable()
export class MarkSheetService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly access: ExamAccessService,
    private readonly exams: ExamService,
    private readonly roster: ExamRosterService,
  ) {}

  private get tenantId(): string {
    return this.context.requirePrincipal().tenantId!;
  }

  // ─────────────────────────── Read ───────────────────────────

  async sheet(examSubjectId: string, sectionId: string): Promise<MarkSheetView> {
    const caller = await this.access.caller();
    const ctx = await this.load(examSubjectId, sectionId, caller);
    return this.view(ctx, caller);
  }

  /** The caller's own subjects in open exams, with how far each sheet is. */
  async mySheets(): Promise<MySheet[]> {
    const caller = await this.access.caller();
    const tx = this.db.tx;
    const assignments = await tx.sectionSubjectTeacher.findMany({
      where: { userId: caller.userId },
      select: {
        subjectId: true,
        section: {
          select: {
            id: true,
            name: true,
            academicYearId: true,
            classLevel: { select: { id: true, code: true, nameBn: true, nameEn: true } },
          },
        },
      },
    });
    if (assignments.length === 0) return [];
    const examSubjects = await tx.examSubject.findMany({
      where: {
        subjectId: { in: [...new Set(assignments.map((a) => a.subjectId))] },
        examClass: { exam: { status: 'OPEN' } },
      },
      orderBy: { sortOrder: 'asc' },
      include: {
        subject: { select: { id: true, code: true, nameBn: true, nameEn: true } },
        components: { select: { key: true } },
        examClass: {
          select: {
            exam: {
              select: {
                id: true,
                nameBn: true,
                nameEn: true,
                kind: true,
                endsOn: true,
                academicYearId: true,
              },
            },
          },
        },
      },
    });
    const out: MySheet[] = [];
    for (const es of examSubjects) {
      const exam = es.examClass.exam;
      for (const a of assignments) {
        if (
          a.subjectId !== es.subjectId ||
          a.section.classLevel.id !== es.classLevelId ||
          a.section.academicYearId !== exam.academicYearId
        ) {
          continue;
        }
        const students = await this.roster.forSheet(exam.id, es, a.section.id);
        const [sheet, marks] = await Promise.all([
          tx.examMarkSheet.findUnique({
            where: {
              tenantId_examSubjectId_sectionId: {
                tenantId: this.tenantId,
                examSubjectId: es.id,
                sectionId: a.section.id,
              },
            },
            select: { status: true, returnNote: true },
          }),
          tx.examMark.findMany({
            where: { examSubjectId: es.id, studentId: { in: students.map((x) => x.studentId) } },
            select: { studentId: true, scoreH: true, absent: true },
          }),
        ]);
        out.push({
          exam: {
            id: exam.id,
            nameBn: exam.nameBn,
            nameEn: exam.nameEn,
            kind: exam.kind,
            endsOn: exam.endsOn.toISOString().slice(0, 10),
          },
          examSubjectId: es.id,
          subject: es.subject,
          section: {
            id: a.section.id,
            name: a.section.name,
            academicYearId: a.section.academicYearId,
            classLevel: a.section.classLevel,
          },
          status: sheet?.status ?? 'DRAFT',
          entered: enteredCount(students, es.components.length, marks),
          total: students.length,
          returnNote: sheet?.returnNote ?? null,
        });
      }
    }
    return out;
  }

  // ─────────────────────────── Save / submit ───────────────────────────

  async save(input: SaveMarkSheetInput): Promise<SaveMarkSheetResult> {
    const caller = await this.access.caller();
    const loaded = await this.load(input.examSubjectId, input.sectionId, caller);
    const tx = this.db.tx;
    await this.lockForMarks(loaded);
    const ctx = await this.withRoster(loaded);
    await tx.examMarkSheet.createMany({
      data: [
        {
          tenantId: this.tenantId,
          examId: ctx.exam.id,
          examSubjectId: ctx.examSubject.id,
          classLevelId: ctx.examSubject.classLevelId,
          sectionId: ctx.section.id,
        },
      ],
      skipDuplicates: true,
    });
    const sheet = await this.lockSheet(ctx.examSubject.id, ctx.section.id);

    if (sheet.lastSubmissionId === input.submissionId) {
      return { ...(await this.view(ctx, caller)), replayed: true };
    }
    if (sheet.status === 'LOCKED') {
      if (!caller.isAdmin) throw apiError(403, 'SHEET_LOCKED', 'The sheet is locked by the office');
      throw apiError(
        409,
        'SHEET_LOCKED',
        'The sheet is locked: correct marks with a reason instead',
      );
    }
    if (input.baseVersion !== sheet.version) {
      throw apiError(409, 'VERSION_CONFLICT', 'Someone changed this sheet meanwhile', {
        sheet: await this.view(ctx, caller),
      });
    }

    const rosterIds = new Set(ctx.students.map((st) => st.studentId));
    const sent = new Set(input.entries.map((e) => e.studentId));
    if (sent.size !== rosterIds.size || [...sent].some((id) => !rosterIds.has(id))) {
      throw apiError(409, 'ROSTER_CHANGED', 'The students of this sheet changed', {
        students: ctx.students,
      });
    }
    const updates = this.parseEntries(ctx, input.entries, true);
    const { changes, after } = await this.diff(ctx, updates);
    if (input.action === 'SUBMIT') {
      const missing = ctx.students.reduce(
        (n, st) =>
          n +
          ctx.components.filter((c) => !filled(after.get(`${st.studentId}:${c.key}`) ?? null))
            .length,
        0,
      );
      if (missing > 0)
        throw apiError(422, 'INCOMPLETE', 'Every student needs marks or absent in every part', {
          missing,
        });
    }
    await this.writeMarks(ctx, changes, caller.userId);

    const status =
      input.action === 'SUBMIT' ? 'SUBMITTED' : changes.length > 0 ? 'DRAFT' : sheet.status;
    const statusChanged = status !== sheet.status || input.action === 'SUBMIT';
    const now = new Date();
    await tx.examMarkSheet.update({
      where: { id: sheet.id },
      data: {
        status,
        lastSubmissionId: input.submissionId,
        ...(changes.length > 0 || statusChanged
          ? { version: { increment: 1 }, updatedById: caller.userId }
          : {}),
        ...(input.action === 'SUBMIT'
          ? { submittedAt: now, submittedById: caller.userId, returnNote: null }
          : {}),
      },
    });
    if (changes.length > 0 || statusChanged) {
      await this.audit.record({
        entity: 'exam_mark_sheet',
        entityId: sheet.id,
        action: sheet.version === 0 ? 'CREATE' : 'UPDATE',
        oldValues: { status: sheet.status, version: sheet.version },
        newValues: { action: input.action, status, changes: auditChanges(changes) },
      });
    }
    return { ...(await this.view(ctx, caller)), replayed: false };
  }

  // ─────────────────────────── Admin: return, lock, unlock, correct ───────────────────────────

  async returnSheet(id: string, note: string): Promise<MarkSheetView> {
    return this.transition(id, 'RETURN', ['SUBMITTED'], 'DRAFT', { returnNote: note }, note);
  }

  async lock(id: string): Promise<MarkSheetView> {
    return this.transition(id, 'LOCK', ['SUBMITTED'], 'LOCKED', {}, null);
  }

  /** Back to SUBMITTED (the teacher may fix it again), only before the class is published. */
  async unlock(id: string, reason: string): Promise<MarkSheetView> {
    return this.transition(id, 'UNLOCK', ['LOCKED'], 'SUBMITTED', {}, reason, {
      refuseWhenPublished: true,
    });
  }

  async lockAll(examId: string, examClassId: string): Promise<LockAllResult> {
    const tx = this.db.tx;
    const caller = await this.access.caller();
    if (!caller.isAdmin) throw new ForbiddenException();
    const examClass = await tx.examClass.findFirst({ where: { id: examClassId, examId } });
    if (!examClass) throw new NotFoundException('Exam class not found');
    await this.lockExamShared(examId);
    await tx.$queryRaw`SELECT id FROM exam_classes WHERE id = ${examClassId}::uuid FOR SHARE`;
    const sheets = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT s.id, s.status::text AS status FROM exam_mark_sheets s
      JOIN exam_subjects es ON es.tenant_id = s.tenant_id AND es.id = s.exam_subject_id
      WHERE es.exam_class_id = ${examClassId}::uuid
      ORDER BY s.id FOR UPDATE OF s`;
    const toLock = sheets.filter((s) => s.status === 'SUBMITTED');
    const now = new Date();
    for (const s of toLock) {
      await tx.examMarkSheet.update({
        where: { id: s.id },
        data: {
          status: 'LOCKED',
          lockedAt: now,
          lockedById: caller.userId,
          returnNote: null,
          version: { increment: 1 },
        },
      });
      await this.audit.record({
        entity: 'exam_mark_sheet',
        entityId: s.id,
        action: 'UPDATE',
        oldValues: { status: 'SUBMITTED' },
        newValues: { action: 'LOCK', status: 'LOCKED', changes: [] },
      });
    }
    const grid = await this.grid(examId);
    const cells = grid.classes.find((c) => c.examClassId === examClassId)?.cells ?? [];
    return {
      locked: toLock.length,
      notSubmitted: cells.filter((c) => c.total > 0 && c.status === 'DRAFT').length,
    };
  }

  async correct(id: string, input: CorrectMarksInput): Promise<MarkSheetView> {
    const caller = await this.access.caller();
    if (!caller.isAdmin) throw new ForbiddenException();
    const loaded = await this.loadById(id, caller);
    const tx = this.db.tx;
    await this.lockForMarks(loaded);
    const ctx = await this.withRoster(loaded);
    const sheet = await this.lockSheet(ctx.examSubject.id, ctx.section.id);
    if (sheet.status !== 'LOCKED') {
      throw apiError(409, 'NOT_LOCKED', 'Only a locked sheet is corrected; edit the sheet instead');
    }
    if (input.baseVersion !== sheet.version) {
      throw apiError(409, 'VERSION_CONFLICT', 'Someone changed this sheet meanwhile', {
        sheet: await this.view(ctx, caller),
      });
    }
    const updates = this.parseEntries(ctx, input.entries, false);
    const { changes } = await this.diff(ctx, updates);
    if (changes.length === 0) throw apiError(422, 'NO_CHANGE', 'Nothing to correct');
    await this.writeMarks(ctx, changes, caller.userId);
    await tx.examMarkSheet.update({
      where: { id },
      data: { version: { increment: 1 }, updatedById: caller.userId },
    });
    const examClass = await tx.examClass.findUniqueOrThrow({
      where: { id: ctx.examSubject.examClassId },
      select: { publishedVersion: true, isPublished: true },
    });
    await this.audit.record({
      entity: 'exam_mark_sheet',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: 'LOCKED', version: sheet.version },
      newValues: {
        action: 'CORRECTION',
        status: 'LOCKED',
        reason: input.reason,
        publishedVersion: examClass.isPublished ? examClass.publishedVersion : null,
        changes: auditChanges(changes),
      },
    });
    return this.view(ctx, caller);
  }

  async history(id: string): Promise<MarkSheetHistoryEntry[]> {
    if (!(await this.access.caller()).isAdmin) throw new ForbiddenException();
    const tx = this.db.tx;
    const exists = await tx.examMarkSheet.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Sheet not found');
    const rows = await tx.auditLog.findMany({
      where: { entity: 'exam_mark_sheet', entityId: id },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, actorUserId: true, newValues: true },
    });
    const names = await staffNames(tx, [
      ...new Set(rows.flatMap((r) => (r.actorUserId ? [r.actorUserId] : []))),
    ]);
    return rows.map((r) => {
      const v = (r.newValues ?? {}) as { action?: Action; reason?: string; changes?: Change[] };
      return {
        at: r.createdAt.toISOString(),
        by: r.actorUserId ? staffRef(names, r.actorUserId) : null,
        action: v.action ?? 'SAVE',
        reason: v.reason ?? null,
        changes: v.changes ?? [],
      };
    });
  }

  /** Every sheet of an exam (admin overview): status and progress per class × section × subject. */
  /** Every sheet of an exam (OWNER/ADMIN; also the dashboard's counts). */
  async grid(examId: string): Promise<ExamSheetsGrid> {
    const tx = this.db.tx;
    await this.exams.detail(examId);
    const examClasses = await tx.examClass.findMany({
      where: { examId },
      include: {
        classLevel: {
          select: { id: true, code: true, nameBn: true, nameEn: true, sortOrder: true },
        },
        subjects: {
          orderBy: { sortOrder: 'asc' },
          include: {
            subject: { select: { id: true, code: true, nameBn: true, nameEn: true } },
            components: { select: { key: true } },
          },
        },
      },
    });
    const exam = await tx.exam.findUniqueOrThrow({
      where: { id: examId },
      select: { academicYearId: true },
    });
    const [candidates, sheets, marks, sections, teachers] = await Promise.all([
      this.roster.candidates(examId),
      tx.examMarkSheet.findMany({
        where: { examId },
        select: { id: true, examSubjectId: true, sectionId: true, status: true },
      }),
      tx.examMark.findMany({
        where: { examId },
        select: { examSubjectId: true, studentId: true, scoreH: true, absent: true },
      }),
      tx.section.findMany({
        where: {
          academicYearId: exam.academicYearId,
          classLevelId: { in: examClasses.map((c) => c.classLevelId) },
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, classLevelId: true, isActive: true },
      }),
      tx.sectionSubjectTeacher.findMany({
        select: { sectionId: true, subjectId: true, userId: true },
      }),
    ]);
    const names = await staffNames(tx, [...new Set(teachers.map((t) => t.userId))]);
    return {
      classes: [...examClasses]
        .sort((a, b) => a.classLevel.sortOrder - b.classLevel.sortOrder)
        .map((ec) => {
          const own = candidates.filter((c) => c.classLevelId === ec.classLevelId);
          const classSections = sections.filter(
            (sec) =>
              sec.classLevelId === ec.classLevelId &&
              (sec.isActive || own.some((c) => c.sectionId === sec.id)),
          );
          return {
            examClassId: ec.id,
            classLevel: {
              id: ec.classLevel.id,
              code: ec.classLevel.code,
              nameBn: ec.classLevel.nameBn,
              nameEn: ec.classLevel.nameEn,
            },
            isPublished: ec.isPublished,
            sections: classSections.map(({ id, name }) => ({ id, name })),
            subjects: ec.subjects.map((es) => ({ examSubjectId: es.id, subject: es.subject })),
            cells: ec.subjects.flatMap((es) =>
              classSections.map((sec) => {
                const students = own.filter((c) => c.sectionId === sec.id && sits(es, c));
                const sheet = sheets.find(
                  (x) => x.examSubjectId === es.id && x.sectionId === sec.id,
                );
                return {
                  examSubjectId: es.id,
                  sectionId: sec.id,
                  sheetId: sheet?.id ?? null,
                  status: sheet?.status ?? 'DRAFT',
                  entered: enteredCount(
                    students,
                    es.components.length,
                    marks.filter((m) => m.examSubjectId === es.id),
                  ),
                  total: students.length,
                  teachers: teachers
                    .filter((t) => t.sectionId === sec.id && t.subjectId === es.subjectId)
                    .map((t) => staffRef(names, t.userId)),
                };
              }),
            ),
          };
        }),
    };
  }

  // ─────────────────────────── Helpers ───────────────────────────

  /** A sheet's context; the caller must be an admin or the subject's teacher in the section. */
  private async load(examSubjectId: string, sectionId: string, caller: ExamCaller) {
    const tx = this.db.tx;
    const examSubject = await tx.examSubject.findUnique({
      where: { id: examSubjectId },
      include: {
        subject: { select: { id: true, code: true, nameBn: true, nameEn: true } },
        components: { orderBy: { sortOrder: 'asc' } },
        passGroups: { orderBy: { kind: 'asc' } },
        examClass: {
          select: {
            exam: {
              select: {
                id: true,
                nameBn: true,
                nameEn: true,
                status: true,
                resultMode: true,
                academicYearId: true,
              },
            },
          },
        },
      },
    });
    const section = await tx.section.findUnique({
      where: { id: sectionId },
      select: {
        id: true,
        name: true,
        academicYearId: true,
        classLevel: {
          select: { id: true, code: true, nameBn: true, nameEn: true, gradingSchemeId: true },
        },
      },
    });
    const exam = examSubject?.examClass.exam;
    if (
      !examSubject ||
      !section ||
      !exam ||
      exam.status === 'SETUP' ||
      section.classLevel.id !== examSubject.classLevelId ||
      section.academicYearId !== exam.academicYearId
    ) {
      throw new NotFoundException('Sheet not found');
    }
    if (!caller.isAdmin) {
      const assigned = await tx.sectionSubjectTeacher.findFirst({
        where: { sectionId, subjectId: examSubject.subjectId, userId: caller.userId },
        select: { id: true },
      });
      if (!assigned) {
        throw apiError(403, 'NOT_ASSIGNED', 'This subject in this section is not yours to mark');
      }
    }
    const students = await this.roster.forSheet(exam.id, examSubject, sectionId);
    return { examSubject, section, exam, components: examSubject.components, students };
  }

  private async loadById(id: string, caller: ExamCaller) {
    const sheet = await this.db.tx.examMarkSheet.findUnique({
      where: { id },
      select: { examSubjectId: true, sectionId: true },
    });
    if (!sheet) throw new NotFoundException('Sheet not found');
    return this.load(sheet.examSubjectId, sheet.sectionId, caller);
  }

  /**
   * Lock order for every marks write (docs/exams.md): the exam row FOR SHARE (setup edits and
   * archiving hold it FOR UPDATE), then the exam class FOR SHARE (publish holds it FOR UPDATE),
   * then the sheet FOR UPDATE. The exam must still be open.
   */
  private async lockForMarks(ctx: Awaited<ReturnType<MarkSheetService['load']>>): Promise<void> {
    await this.lockExamShared(ctx.exam.id);
    await this.db.tx.$queryRaw`SELECT id FROM exam_classes
      WHERE id = ${ctx.examSubject.examClassId}::uuid FOR SHARE`;
  }

  private async lockExamShared(examId: string): Promise<void> {
    const [row] = await this.db.tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM exams WHERE id = ${examId}::uuid FOR SHARE`;
    if (row?.status !== 'OPEN') {
      throw apiError(409, 'NOT_OPEN', 'Marks change only while the exam is open');
    }
  }

  /** The context with the sheet's students read again (after the locks are held). */
  private async withRoster(ctx: Awaited<ReturnType<MarkSheetService['load']>>) {
    return {
      ...ctx,
      students: await this.roster.forSheet(ctx.exam.id, ctx.examSubject, ctx.section.id),
    };
  }

  private async lockSheet(examSubjectId: string, sectionId: string) {
    const tx = this.db.tx;
    await tx.$queryRaw`SELECT id FROM exam_mark_sheets
      WHERE exam_subject_id = ${examSubjectId}::uuid AND section_id = ${sectionId}::uuid FOR UPDATE`;
    return tx.examMarkSheet.findUniqueOrThrow({
      where: {
        tenantId_examSubjectId_sectionId: { tenantId: this.tenantId, examSubjectId, sectionId },
      },
    });
  }

  /** Parse every cell typed; a blank is allowed only while entering (not in a correction). */
  private parseEntries(
    ctx: Awaited<ReturnType<MarkSheetService['load']>>,
    entries: { studentId: string; key: string; value: string }[],
    allowBlank: boolean,
  ): Map<string, MarkCell> {
    const rosterIds = new Set(ctx.students.map((s) => s.studentId));
    const out = new Map<string, MarkCell>();
    for (const e of entries) {
      const component = ctx.components.find((c) => c.key === e.key);
      if (!component)
        throw apiError(422, 'UNKNOWN_PART', 'Not a part of this subject', { key: e.key });
      if (!rosterIds.has(e.studentId)) {
        throw apiError(422, 'UNKNOWN_STUDENT', 'The student does not sit this subject here', {
          studentId: e.studentId,
        });
      }
      const parsed = parseMarks(e.value, component.fullMarks);
      if (parsed.kind === 'invalid' || (parsed.kind === 'blank' && !allowBlank)) {
        throw apiError(
          422,
          'INVALID_MARKS',
          'Marks must be a number up to the full marks, or absent',
          {
            studentId: e.studentId,
            key: e.key,
            reason: parsed.kind === 'invalid' ? parsed.reason : 'BLANK',
          },
        );
      }
      out.set(
        `${e.studentId}:${e.key}`,
        parsed.kind === 'marks'
          ? { scoreH: parsed.hundredths, absent: false }
          : parsed.kind === 'absent'
            ? { scoreH: null, absent: true }
            : BLANK,
      );
    }
    return out;
  }

  /** The cells that change, and the sheet as it will be. */
  private diff(ctx: Awaited<ReturnType<MarkSheetService['load']>>, updates: Map<string, MarkCell>) {
    return this.currentMarks(ctx).then((current) => {
      const changes: Change[] = [];
      const after = new Map(current);
      for (const [cell, to] of updates) {
        const from = current.get(cell) ?? null;
        if (sameCell(from, to)) continue;
        const [studentId, key] = cell.split(':') as [string, string];
        changes.push({ studentId, key, from, to });
        after.set(cell, filled(to) ? to : null);
      }
      return { changes, after };
    });
  }

  private async currentMarks(ctx: Awaited<ReturnType<MarkSheetService['load']>>) {
    const rows = await this.db.tx.examMark.findMany({
      where: {
        examSubjectId: ctx.examSubject.id,
        studentId: { in: ctx.students.map((s) => s.studentId) },
      },
      select: { studentId: true, scoreH: true, absent: true, component: { select: { key: true } } },
    });
    return new Map<string, MarkCell | null>(
      rows.map((r) => [`${r.studentId}:${r.component.key}`, cellOf(r)]),
    );
  }

  private async writeMarks(
    ctx: Awaited<ReturnType<MarkSheetService['load']>>,
    changes: Change[],
    userId: string,
  ): Promise<void> {
    if (changes.length === 0) return;
    const tx = this.db.tx;
    const componentIds = new Map(ctx.components.map((c) => [c.key, c.id]));
    const existing = await tx.examMark.findMany({
      where: {
        examSubjectId: ctx.examSubject.id,
        studentId: { in: [...new Set(changes.map((c) => c.studentId))] },
      },
      select: { id: true, studentId: true, componentId: true },
    });
    const idOf = new Map(existing.map((m) => [`${m.studentId}:${m.componentId}`, m.id]));
    const create: { studentId: string; componentId: string; to: MarkCell }[] = [];
    for (const ch of changes) {
      const componentId = componentIds.get(ch.key)!;
      const id = idOf.get(`${ch.studentId}:${componentId}`);
      if (id) {
        await tx.examMark.update({
          where: { id },
          data: { scoreH: ch.to.scoreH, absent: ch.to.absent, updatedById: userId },
        });
      } else {
        create.push({ studentId: ch.studentId, componentId, to: ch.to });
      }
    }
    if (create.length > 0) {
      await tx.examMark.createMany({
        data: create.map((c) => ({
          tenantId: this.tenantId,
          examId: ctx.exam.id,
          examSubjectId: ctx.examSubject.id,
          componentId: c.componentId,
          studentId: c.studentId,
          scoreH: c.to.scoreH,
          absent: c.to.absent,
          updatedById: userId,
        })),
      });
    }
  }

  private async transition(
    id: string,
    action: Action,
    from: ('DRAFT' | 'SUBMITTED' | 'LOCKED')[],
    to: 'DRAFT' | 'SUBMITTED' | 'LOCKED',
    extra: { returnNote?: string },
    reason: string | null,
    opts: { refuseWhenPublished?: boolean } = {},
  ): Promise<MarkSheetView> {
    const caller = await this.access.caller();
    if (!caller.isAdmin) throw new ForbiddenException();
    const ctx = await this.loadById(id, caller);
    const tx = this.db.tx;
    await this.lockForMarks(ctx);
    if (opts.refuseWhenPublished) {
      // Read under the exam class lock: a publish can't commit between this check and the change.
      const examClass = await tx.examClass.findUniqueOrThrow({
        where: { id: ctx.examSubject.examClassId },
        select: { isPublished: true },
      });
      if (examClass.isPublished) {
        throw apiError(
          409,
          'PUBLISHED',
          'Results are published: correct marks with a reason, or unpublish first',
        );
      }
    }
    const sheet = await this.lockSheet(ctx.examSubject.id, ctx.section.id);
    if (!from.includes(sheet.status)) {
      throw apiError(409, 'WRONG_STATUS', `The sheet is ${sheet.status.toLowerCase()}`, {
        status: sheet.status,
      });
    }
    const now = new Date();
    await tx.examMarkSheet.update({
      where: { id },
      data: {
        status: to,
        version: { increment: 1 },
        returnNote: extra.returnNote ?? null,
        ...(to === 'LOCKED' ? { lockedAt: now, lockedById: caller.userId } : {}),
      },
    });
    await this.audit.record({
      entity: 'exam_mark_sheet',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: sheet.status },
      newValues: { action, status: to, reason, changes: [] },
    });
    return this.view(ctx, caller);
  }

  private async view(
    ctx: Awaited<ReturnType<MarkSheetService['load']>>,
    caller: ExamCaller,
  ): Promise<MarkSheetView> {
    const tx = this.db.tx;
    const sheet = await tx.examMarkSheet.findUnique({
      where: {
        tenantId_examSubjectId_sectionId: {
          tenantId: this.tenantId,
          examSubjectId: ctx.examSubject.id,
          sectionId: ctx.section.id,
        },
      },
    });
    const current = await this.currentMarks(ctx);
    const people = [sheet?.updatedById, sheet?.submittedById, sheet?.lockedById].filter(
      (x): x is string => !!x,
    );
    const names = await staffNames(tx, [...new Set(people)]);
    const ref = (id: string | null | undefined) => (id ? staffRef(names, id) : null);
    const scheme =
      ctx.exam.resultMode === 'GPA'
        ? await tx.gradingScheme.findFirst({
            where: ctx.section.classLevel.gradingSchemeId
              ? { id: ctx.section.classLevel.gradingSchemeId }
              : { isDefault: true },
            include: { bands: { orderBy: { minPercent: 'desc' } } },
          })
        : null;
    const status = sheet?.status ?? 'DRAFT';
    const mode: MarkSheetView['mode'] =
      ctx.exam.status === 'ARCHIVED'
        ? 'READ_ONLY'
        : status === 'LOCKED'
          ? caller.isAdmin
            ? 'CORRECTION'
            : 'READ_ONLY'
          : caller.isAdmin
            ? 'ADMIN'
            : 'TEACHER';
    const es = ctx.examSubject;
    return {
      exam: {
        id: ctx.exam.id,
        nameBn: ctx.exam.nameBn,
        nameEn: ctx.exam.nameEn,
        status: ctx.exam.status,
        resultMode: ctx.exam.resultMode,
      },
      examSubject: {
        id: es.id,
        subject: es.subject,
        studyGroupId: es.studyGroupId,
        isElective: es.isElective,
        passRule: es.passRule,
        examDate: es.examDate ? es.examDate.toISOString().slice(0, 10) : null,
        startTime: es.startTime,
        fullMarks: es.components.reduce((n, c) => n + c.fullMarks, 0),
        components: es.components.map((c) => ({
          key: c.key,
          kind: c.kind,
          nameBn: c.nameBn,
          nameEn: c.nameEn,
          fullMarks: c.fullMarks,
          passMarks: c.passMarks,
        })),
        passGroups: es.passGroups.map((g) => ({ kind: g.kind, passMarks: g.passMarks })),
      },
      section: {
        id: ctx.section.id,
        name: ctx.section.name,
        academicYearId: ctx.section.academicYearId,
        classLevel: {
          id: ctx.section.classLevel.id,
          code: ctx.section.classLevel.code,
          nameBn: ctx.section.classLevel.nameBn,
          nameEn: ctx.section.classLevel.nameEn,
        },
      },
      sheet: {
        id: sheet?.id ?? null,
        status,
        version: sheet?.version ?? 0,
        returnNote: sheet?.returnNote ?? null,
        updatedAt: sheet && sheet.version > 0 ? sheet.updatedAt.toISOString() : null,
        updatedBy: ref(sheet?.updatedById),
        submittedAt: sheet?.submittedAt?.toISOString() ?? null,
        submittedBy: ref(sheet?.submittedById),
        lockedAt: sheet?.lockedAt?.toISOString() ?? null,
        lockedBy: ref(sheet?.lockedById),
      },
      grading: scheme
        ? {
            roundingMode: scheme.roundingMode,
            bands: scheme.bands.map((b) => ({
              minPercent: b.minPercent.toNumber(),
              maxPercent: b.maxPercent.toNumber(),
              letter: b.letter,
              gradePoint: b.gradePoint.toNumber(),
            })),
          }
        : null,
      mode,
      students: ctx.students.map((st) => ({
        studentId: st.studentId,
        studentCode: st.studentCode,
        nameBn: st.nameBn,
        nameEn: st.nameEn,
        roll: st.roll,
        marks: Object.fromEntries(
          ctx.components.flatMap((c) => {
            const cell = current.get(`${st.studentId}:${c.key}`) ?? null;
            return cell ? [[c.key, cell]] : [];
          }),
        ),
      })),
    };
  }
}

/** Students with every part entered (marks or absent). */
function enteredCount(
  students: Pick<RosterStudent, 'studentId'>[],
  parts: number,
  marks: { studentId: string; scoreH: number | null; absent: boolean }[],
): number {
  if (parts === 0) return 0;
  const filledByStudent = new Map<string, number>();
  for (const m of marks) {
    if (m.absent || m.scoreH !== null) {
      filledByStudent.set(m.studentId, (filledByStudent.get(m.studentId) ?? 0) + 1);
    }
  }
  return students.filter((s) => (filledByStudent.get(s.studentId) ?? 0) >= parts).length;
}

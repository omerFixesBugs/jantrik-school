import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DEFAULT_MERIT_ORDER,
  addDays,
  dateFromDb,
  dateToDb,
  type CandidateSyncResult,
  type CreateExamInput,
  type ExamCandidateView,
  type ExamDetail,
  type ExamListItem,
  type ExamSubjectSetupInput,
  type ExamSubjectView,
  type IsoDate,
  type MeritKey,
  type UpdateExamInput,
} from '@jantrik/shared';
import type { Prisma } from '@jantrik/db';
import { AuditService } from '../../audit/audit.module.js';
import { apiError } from '../../common/api-error.js';
import { RequestContext } from '../../common/request-context.js';
import { Db } from '../../tenancy/db.service.js';
import { ExamAccessService } from '../exam-access.service.js';

const classLevelRef = {
  select: { id: true, code: true, nameBn: true, nameEn: true, sortOrder: true },
};

const examInclude = {
  classes: {
    include: {
      classLevel: classLevelRef,
      subjects: {
        orderBy: { sortOrder: 'asc' },
        include: {
          subject: { select: { id: true, code: true, nameBn: true, nameEn: true } },
          components: { orderBy: { sortOrder: 'asc' } },
          passGroups: { orderBy: { kind: 'asc' } },
        },
      },
    },
  },
  _count: { select: { candidates: { where: { status: 'ENROLLED' } } } },
} as const satisfies Prisma.ExamInclude;

type ExamRow = Prisma.ExamGetPayload<{ include: typeof examInclude }>;
type ExamSubjectRow = ExamRow['classes'][number]['subjects'][number];

const studentName = (s: { nameBn: string | null; nameEn: string | null }) =>
  s.nameEn ?? s.nameBn ?? '';

/**
 * Exams (docs/exams.md): an exam of a year, the classes it covers and each class's subjects with
 * their setup copied from the subject (parts, combined pass marks, the elective flag), so later
 * setup changes never alter an exam. Opening takes the roster (exam_candidates).
 */
@Injectable()
export class ExamService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly access: ExamAccessService,
  ) {}

  private get tenantId(): string {
    return this.context.requirePrincipal().tenantId!;
  }

  // ─────────────────────────── Read ───────────────────────────

  /** Admins see every exam; teachers only open and archived ones (no setup drafts). */
  async list(academicYearId?: string): Promise<ExamListItem[]> {
    const caller = await this.access.caller();
    const rows = await this.db.tx.exam.findMany({
      where: {
        ...(academicYearId ? { academicYearId } : {}),
        ...(caller.isAdmin ? {} : { status: { in: ['OPEN', 'ARCHIVED'] } }),
      },
      orderBy: [{ startsOn: 'desc' }, { createdAt: 'desc' }],
      include: examInclude,
    });
    return rows.map((r) => {
      const { meritOrder: _m, failedRanking: _f, attendance: _a, classes, ...item } = toDetail(r);
      return { ...item, classes: classes.map(({ subjects: _s, ...c }) => c) };
    });
  }

  async detail(id: string): Promise<ExamDetail> {
    const caller = await this.access.caller();
    const row = await this.db.tx.exam.findUnique({ where: { id }, include: examInclude });
    if (!row || (!caller.isAdmin && row.status === 'SETUP')) {
      throw new NotFoundException('Exam not found');
    }
    return toDetail(row);
  }

  // ─────────────────────────── Write (OWNER/ADMIN) ───────────────────────────

  async create(input: CreateExamInput): Promise<ExamDetail> {
    const tx = this.db.tx;
    const year = await tx.academicYear.findUnique({ where: { id: input.academicYearId } });
    if (!year) throw new NotFoundException('Academic year not found');
    assertInYear(year, input.startsOn, input.endsOn);
    const last = await tx.exam.findFirst({
      where: { resultMode: input.resultMode },
      orderBy: { createdAt: 'desc' },
      select: { meritOrder: true, failedRanking: true },
    });
    const attendance =
      input.attendance === undefined
        ? await this.defaultAttendance(year, input.startsOn, input.endsOn)
        : input.attendance;
    const data = {
      kind: input.kind,
      nameBn: input.nameBn,
      nameEn: input.nameEn,
      startsOn: dateToDb(input.startsOn),
      endsOn: dateToDb(input.endsOn),
      resultMode: input.resultMode,
      meritOrder: input.meritOrder ?? last?.meritOrder ?? DEFAULT_MERIT_ORDER[input.resultMode],
      failedRanking: input.failedRanking ?? last?.failedRanking ?? 'AFTER_PASSED',
      attendanceFrom: attendance ? dateToDb(attendance.from) : null,
      attendanceTo: attendance ? dateToDb(attendance.to) : null,
    };
    const exam = await tx.exam.create({
      data: { tenantId: this.tenantId, academicYearId: year.id, ...data },
    });
    await this.audit.record({
      entity: 'exams',
      entityId: exam.id,
      action: 'CREATE',
      newValues: { ...input, ...auditDates(data) },
    });
    return this.detail(exam.id);
  }

  async update(id: string, input: UpdateExamInput): Promise<ExamDetail> {
    const tx = this.db.tx;
    const before = await this.lockExam(id);
    if (input.resultMode && input.resultMode !== before.resultMode && before.status !== 'SETUP') {
      throw apiError(
        409,
        'NOT_IN_SETUP',
        'The result mode changes only while the exam is in setup',
      );
    }
    const startsOn = input.startsOn ?? dateFromDb(before.startsOn);
    const endsOn = input.endsOn ?? dateFromDb(before.endsOn);
    if (startsOn > endsOn) throw apiError(422, 'INVALID_DATES', 'The exam ends before it starts');
    const year = await tx.academicYear.findUniqueOrThrow({ where: { id: before.academicYearId } });
    assertInYear(year, startsOn, endsOn);
    const data = {
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.nameBn ? { nameBn: input.nameBn } : {}),
      ...(input.nameEn ? { nameEn: input.nameEn } : {}),
      startsOn: dateToDb(startsOn),
      endsOn: dateToDb(endsOn),
      ...(input.resultMode ? { resultMode: input.resultMode } : {}),
      ...(input.meritOrder ? { meritOrder: input.meritOrder } : {}),
      ...(input.failedRanking ? { failedRanking: input.failedRanking } : {}),
      ...(input.attendance !== undefined
        ? {
            attendanceFrom: input.attendance ? dateToDb(input.attendance.from) : null,
            attendanceTo: input.attendance ? dateToDb(input.attendance.to) : null,
          }
        : {}),
    };
    await tx.exam.update({ where: { id }, data });
    await this.audit.record({
      entity: 'exams',
      entityId: id,
      action: 'UPDATE',
      oldValues: auditDates(before),
      newValues: { ...input },
    });
    return this.detail(id);
  }

  /** Only an exam still in setup (no roster, no marks) can be deleted. */
  async remove(id: string): Promise<void> {
    const before = await this.lockExam(id);
    if (before.status !== 'SETUP') {
      throw apiError(
        409,
        'NOT_IN_SETUP',
        'Only an exam in setup can be deleted; archive it instead',
      );
    }
    await this.db.tx.exam.delete({ where: { id } });
    await this.audit.record({
      entity: 'exams',
      entityId: id,
      action: 'DELETE',
      oldValues: auditDates(before),
    });
  }

  /**
   * The classes the exam covers. A new class gets every active subject with its setup copied; a
   * class that already has a roster cannot be dropped. Once open, a new class's roster is taken.
   */
  async setClasses(id: string, classLevelIds: string[]): Promise<ExamDetail> {
    const tx = this.db.tx;
    const exam = await this.lockExam(id);
    if (exam.status === 'ARCHIVED') throw apiError(409, 'ARCHIVED', 'The exam is archived');
    const levels = await tx.classLevel.findMany({ where: { id: { in: classLevelIds } } });
    if (levels.length !== classLevelIds.length) {
      throw apiError(422, 'UNKNOWN_CLASS', 'A class is not one of this institute’s');
    }
    const current = await tx.examClass.findMany({
      where: { examId: id },
      select: { id: true, classLevelId: true, _count: { select: { candidates: true } } },
    });
    const dropped = current.filter((c) => !classLevelIds.includes(c.classLevelId));
    if (dropped.some((c) => c._count.candidates > 0)) {
      throw apiError(409, 'CLASS_IN_USE', 'A class with a roster cannot be dropped from the exam');
    }
    if (dropped.length > 0) {
      await tx.examClass.deleteMany({ where: { id: { in: dropped.map((c) => c.id) } } });
    }
    const added = classLevelIds.filter((cl) => !current.some((c) => c.classLevelId === cl));
    for (const classLevelId of added) {
      const examClass = await tx.examClass.create({
        data: { tenantId: this.tenantId, examId: id, classLevelId },
      });
      const subjects = await tx.subject.findMany({
        where: { classLevelId, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
        select: { id: true },
      });
      await this.copySubjects(
        examClass,
        subjects.map((s) => s.id),
        0,
      );
      if (exam.status === 'OPEN') await this.takeRoster(id, exam.academicYearId, [classLevelId]);
    }
    await this.audit.record({
      entity: 'exam_classes',
      entityId: id,
      action: 'UPDATE',
      oldValues: { classLevelIds: current.map((c) => c.classLevelId) },
      newValues: { classLevelIds },
    });
    return this.detail(id);
  }

  /** Which subjects an exam class sits; kept ones keep their setup, new ones copy the subject's. */
  async setClassSubjects(
    id: string,
    examClassId: string,
    subjectIds: string[],
  ): Promise<ExamDetail> {
    const tx = this.db.tx;
    const exam = await this.lockExam(id);
    if (exam.status === 'ARCHIVED') throw apiError(409, 'ARCHIVED', 'The exam is archived');
    const examClass = await tx.examClass.findFirst({ where: { id: examClassId, examId: id } });
    if (!examClass) throw new NotFoundException('Exam class not found');
    const valid = await tx.subject.findMany({
      where: { id: { in: subjectIds }, classLevelId: examClass.classLevelId },
      select: { id: true },
    });
    if (valid.length !== subjectIds.length) {
      throw apiError(422, 'SUBJECT_NOT_IN_CLASS', 'A subject is not one of this class');
    }
    const current = await tx.examSubject.findMany({
      where: { examClassId },
      select: { id: true, subjectId: true },
    });
    const dropped = current.filter((c) => !subjectIds.includes(c.subjectId)).map((c) => c.id);
    if (dropped.length > 0) {
      const marked = await tx.examMark.count({ where: { examSubjectId: { in: dropped } } });
      const sheets = await tx.examMarkSheet.count({ where: { examSubjectId: { in: dropped } } });
      if (marked + sheets > 0) {
        throw apiError(409, 'MARKS_EXIST', 'A subject with marks cannot be dropped from the exam');
      }
      await tx.examSubject.deleteMany({ where: { id: { in: dropped } } });
    }
    const added = subjectIds.filter((sid) => !current.some((c) => c.subjectId === sid));
    await this.copySubjects(examClass, added, current.length);
    for (const [i, subjectId] of subjectIds.entries()) {
      await tx.examSubject.updateMany({
        where: { examClassId, subjectId },
        data: { sortOrder: i },
      });
    }
    await this.audit.record({
      entity: 'exam_subjects',
      entityId: examClassId,
      action: 'UPDATE',
      oldValues: { subjectIds: current.map((c) => c.subjectId) },
      newValues: { subjectIds },
    });
    return this.detail(id);
  }

  /** One exam subject's routine, parts and pass rule. */
  async setSubject(
    id: string,
    examSubjectId: string,
    input: ExamSubjectSetupInput,
  ): Promise<ExamSubjectView> {
    const tx = this.db.tx;
    const exam = await this.lockExam(id);
    if (exam.status === 'ARCHIVED') throw apiError(409, 'ARCHIVED', 'The exam is archived');
    const before = await this.subjectRow(id, examSubjectId);
    // Sheet writes hold the exam row FOR SHARE, so no mark lands between this check and the edit.
    if ((await tx.examMark.count({ where: { examSubjectId } })) > 0) {
      throw apiError(409, 'MARKS_EXIST', 'Marks are already entered for this subject');
    }
    const tenantId = this.tenantId;
    await tx.examSubjectComponent.deleteMany({ where: { examSubjectId } });
    await tx.examSubjectPassGroup.deleteMany({ where: { examSubjectId } });
    await tx.examSubjectComponent.createMany({
      data: input.components.map((c, i) => ({
        tenantId,
        examSubjectId,
        key: c.key,
        kind: c.kind,
        nameBn: c.nameBn,
        nameEn: c.nameEn,
        fullMarks: c.fullMarks,
        passMarks: c.passMarks,
        sortOrder: i,
      })),
    });
    if (input.passRule === 'COMBINED') {
      await tx.examSubjectPassGroup.createMany({
        data: input.passGroups.map((g) => ({
          tenantId,
          examSubjectId,
          kind: g.kind,
          passMarks: g.passMarks,
        })),
      });
    }
    await tx.examSubject.update({
      where: { id: examSubjectId },
      data: {
        passRule: input.passRule,
        examDate: input.examDate ? dateToDb(input.examDate) : null,
        startTime: input.startTime,
      },
    });
    const after = toSubjectView(await this.subjectRow(id, examSubjectId));
    await this.audit.record({
      entity: 'exam_subjects',
      entityId: examSubjectId,
      action: 'UPDATE',
      oldValues: subjectSnapshot(toSubjectView(before)),
      newValues: subjectSnapshot(after),
    });
    return after;
  }

  /** SETUP → OPEN: every class needs a subject; the roster of every covered class is taken. */
  async open(id: string): Promise<ExamDetail> {
    const exam = await this.lockExam(id);
    if (exam.status !== 'SETUP') throw apiError(409, 'NOT_IN_SETUP', 'The exam is already open');
    const classes = await this.db.tx.examClass.findMany({
      where: { examId: id },
      select: { classLevelId: true, _count: { select: { subjects: true } } },
    });
    if (classes.length === 0 || classes.some((c) => c._count.subjects === 0)) {
      throw apiError(422, 'NOT_READY', 'Every class of the exam needs at least one subject');
    }
    await this.db.tx.exam.update({ where: { id }, data: { status: 'OPEN' } });
    const taken = await this.takeRoster(
      id,
      exam.academicYearId,
      classes.map((c) => c.classLevelId),
    );
    await this.audit.record({
      entity: 'exams',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: 'SETUP' },
      newValues: { status: 'OPEN', candidates: taken },
    });
    return this.detail(id);
  }

  async setArchived(id: string, archived: boolean): Promise<ExamDetail> {
    const exam = await this.lockExam(id);
    const from = archived ? 'OPEN' : 'ARCHIVED';
    if (exam.status !== from) throw apiError(409, 'WRONG_STATUS', `The exam is not ${from}`);
    const status = archived ? 'ARCHIVED' : 'OPEN';
    await this.db.tx.exam.update({ where: { id }, data: { status } });
    await this.audit.record({
      entity: 'exams',
      entityId: id,
      action: 'UPDATE',
      oldValues: { status: from },
      newValues: { status },
    });
    return this.detail(id);
  }

  // ─────────────────────────── Roster ───────────────────────────

  async candidates(id: string, sectionId?: string): Promise<ExamCandidateView[]> {
    await this.detail(id);
    const rows = await this.db.tx.examCandidate.findMany({
      where: { examId: id, ...(sectionId ? { sectionId } : {}) },
      orderBy: [{ classLevelId: 'asc' }, { section: { name: 'asc' } }, { roll: 'asc' }],
      include: {
        student: { select: { id: true, studentCode: true, nameBn: true, nameEn: true } },
        section: { select: { id: true, name: true } },
        room: { select: { id: true, name: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      student: r.student,
      classLevelId: r.classLevelId,
      section: r.section,
      studyGroupId: r.studyGroupId,
      roll: r.roll,
      status: r.status,
      seat:
        r.room && r.seatNo ? { roomId: r.room.id, roomName: r.room.name, seatNo: r.seatNo } : null,
    }));
  }

  /**
   * Bring the roster in line with the enrolments of the covered classes: add newcomers, withdraw
   * leavers (their marks stay, they leave the results) and follow transfers (section, group,
   * roll). `dryRun` only reports. Locks every exam class, so no publish runs meanwhile.
   */
  async syncCandidates(id: string, dryRun: boolean): Promise<CandidateSyncResult> {
    const tx = this.db.tx;
    const exam = await this.lockExam(id);
    if (exam.status !== 'OPEN') throw apiError(409, 'NOT_OPEN', 'The exam is not open');
    await tx.$queryRaw`SELECT id FROM exam_classes WHERE exam_id = ${id}::uuid ORDER BY id FOR UPDATE`;
    const classIds = (
      await tx.examClass.findMany({ where: { examId: id }, select: { classLevelId: true } })
    ).map((c) => c.classLevelId);
    const enrolments = await this.enrolled(exam.academicYearId, classIds);
    const candidates = await tx.examCandidate.findMany({
      where: { examId: id },
      include: {
        student: { select: { nameBn: true, nameEn: true } },
        section: { select: { name: true } },
      },
    });
    const byStudent = new Map(candidates.map((c) => [c.studentId, c]));
    const enrolledIds = new Set(enrolments.map((e) => e.studentId));
    const result: CandidateSyncResult = { dryRun, added: [], withdrawn: [], moved: [] };
    for (const e of enrolments) {
      const c = byStudent.get(e.studentId);
      const name = studentName(e.student);
      if (!c) {
        result.added.push({ studentId: e.studentId, name, sectionName: e.section!.name });
      } else if (
        c.status === 'WITHDRAWN' ||
        c.sectionId !== e.sectionId ||
        c.classLevelId !== e.classLevelId ||
        c.roll !== e.roll ||
        c.studyGroupId !== e.studyGroupId
      ) {
        if (c.sectionId !== e.sectionId) {
          result.moved.push({
            studentId: e.studentId,
            name,
            from: c.section.name,
            to: e.section!.name,
          });
        }
        if (!dryRun) {
          await tx.examCandidate.update({
            where: { id: c.id },
            data: {
              status: 'ENROLLED',
              classLevelId: e.classLevelId,
              sectionId: e.sectionId!,
              studyGroupId: e.studyGroupId,
              roll: e.roll,
            },
          });
        }
      }
    }
    for (const c of candidates) {
      if (c.status === 'ENROLLED' && !enrolledIds.has(c.studentId)) {
        result.withdrawn.push({ studentId: c.studentId, name: studentName(c.student) });
        if (!dryRun) {
          await tx.examCandidate.update({
            where: { id: c.id },
            data: { status: 'WITHDRAWN', roomId: null, seatNo: null },
          });
        }
      }
    }
    if (!dryRun) {
      const added = enrolments.filter((e) => !byStudent.has(e.studentId));
      await tx.examCandidate.createMany({ data: added.map((e) => this.candidateData(id, e)) });
      if (result.added.length + result.withdrawn.length + result.moved.length > 0) {
        await this.audit.record({
          entity: 'exam_candidates',
          entityId: id,
          action: 'UPDATE',
          newValues: {
            added: result.added.map((a) => a.studentId),
            withdrawn: result.withdrawn.map((w) => w.studentId),
            moved: result.moved.map((m) => m.studentId),
          },
        });
      }
    }
    return result;
  }

  // ─────────────────────────── Helpers ───────────────────────────

  /** The exam row, locked for this transaction (one writer per exam's setup at a time). */
  async lockExam(id: string) {
    const tx = this.db.tx;
    await tx.$queryRaw`SELECT id FROM exams WHERE id = ${id}::uuid FOR UPDATE`;
    const exam = await tx.exam.findUnique({ where: { id } });
    if (!exam) throw new NotFoundException('Exam not found');
    return exam;
  }

  private async subjectRow(examId: string, examSubjectId: string): Promise<ExamSubjectRow> {
    const row = await this.db.tx.examSubject.findFirst({
      where: { id: examSubjectId, examId },
      include: examInclude.classes.include.subjects.include,
    });
    if (!row) throw new NotFoundException('Exam subject not found');
    return row;
  }

  /** Copy subjects' current setup into an exam class. */
  private async copySubjects(
    examClass: { id: string; examId: string; classLevelId: string },
    subjectIds: string[],
    firstSort: number,
  ): Promise<void> {
    if (subjectIds.length === 0) return;
    const tx = this.db.tx;
    const tenantId = this.tenantId;
    const subjects = await tx.subject.findMany({
      where: { id: { in: subjectIds } },
      include: { components: { orderBy: { sortOrder: 'asc' } }, passGroups: true },
    });
    const byId = new Map(subjects.map((s) => [s.id, s]));
    for (const [i, subjectId] of subjectIds.entries()) {
      const s = byId.get(subjectId)!;
      const examSubject = await tx.examSubject.create({
        data: {
          tenantId,
          examId: examClass.examId,
          examClassId: examClass.id,
          classLevelId: examClass.classLevelId,
          subjectId: s.id,
          studyGroupId: s.studyGroupId,
          isElective: s.isOptional,
          passRule: s.passRule,
          sortOrder: firstSort + i,
        },
      });
      await tx.examSubjectComponent.createMany({
        data: s.components.map((c) => ({
          tenantId,
          examSubjectId: examSubject.id,
          key: c.key,
          kind: c.kind,
          nameBn: c.nameBn,
          nameEn: c.nameEn,
          fullMarks: c.fullMarks,
          passMarks: c.passMarks,
          sortOrder: c.sortOrder,
        })),
      });
      await tx.examSubjectPassGroup.createMany({
        data: s.passGroups.map((g) => ({
          tenantId,
          examSubjectId: examSubject.id,
          kind: g.kind,
          passMarks: g.passMarks,
        })),
      });
    }
  }

  /** Students enrolled (with a section) in these classes this year, active and not deleted. */
  private enrolled(academicYearId: string, classLevelIds: string[]) {
    return this.db.tx.enrolment.findMany({
      where: {
        academicYearId,
        classLevelId: { in: classLevelIds },
        sectionId: { not: null },
        student: { deletedAt: null, status: 'ACTIVE' },
      },
      select: {
        studentId: true,
        classLevelId: true,
        sectionId: true,
        studyGroupId: true,
        roll: true,
        student: { select: { nameBn: true, nameEn: true } },
        section: { select: { name: true } },
      },
    });
  }

  private candidateData(
    examId: string,
    e: {
      studentId: string;
      classLevelId: string;
      sectionId: string | null;
      studyGroupId: string | null;
      roll: number | null;
    },
  ) {
    return {
      tenantId: this.tenantId,
      examId,
      studentId: e.studentId,
      classLevelId: e.classLevelId,
      sectionId: e.sectionId!,
      studyGroupId: e.studyGroupId,
      roll: e.roll,
    };
  }

  private async takeRoster(examId: string, academicYearId: string, classLevelIds: string[]) {
    const enrolments = await this.enrolled(academicYearId, classLevelIds);
    await this.db.tx.examCandidate.createMany({
      data: enrolments.map((e) => this.candidateData(examId, e)),
      skipDuplicates: true,
    });
    return enrolments.length;
  }

  private async defaultAttendance(
    year: { id: string; startDate: Date },
    startsOn: IsoDate,
    endsOn: IsoDate,
  ): Promise<{ from: IsoDate; to: IsoDate }> {
    const previous = await this.db.tx.exam.findFirst({
      where: { academicYearId: year.id, resultMode: 'GPA', endsOn: { lt: dateToDb(startsOn) } },
      orderBy: { endsOn: 'desc' },
      select: { endsOn: true },
    });
    const from = previous ? addDays(dateFromDb(previous.endsOn), 1) : dateFromDb(year.startDate);
    return { from: from <= endsOn ? from : dateFromDb(year.startDate), to: endsOn };
  }
}

function assertInYear(
  year: { startDate: Date; endDate: Date },
  startsOn: IsoDate,
  endsOn: IsoDate,
) {
  if (startsOn < dateFromDb(year.startDate) || endsOn > dateFromDb(year.endDate)) {
    throw apiError(422, 'OUTSIDE_YEAR', 'The exam must fall inside its academic year', {
      fields: ['startsOn', 'endsOn'],
    });
  }
}

const auditDates = (e: {
  startsOn: Date;
  endsOn: Date;
  attendanceFrom: Date | null;
  attendanceTo: Date | null;
  [k: string]: unknown;
}) => ({
  ...Object.fromEntries(
    Object.entries(e).filter(([k]) => !['createdAt', 'updatedAt', 'tenantId', 'id'].includes(k)),
  ),
  startsOn: dateFromDb(e.startsOn),
  endsOn: dateFromDb(e.endsOn),
  attendanceFrom: e.attendanceFrom ? dateFromDb(e.attendanceFrom) : null,
  attendanceTo: e.attendanceTo ? dateFromDb(e.attendanceTo) : null,
});

function toSubjectView(s: ExamSubjectRow): ExamSubjectView {
  return {
    id: s.id,
    subject: s.subject,
    studyGroupId: s.studyGroupId,
    isElective: s.isElective,
    passRule: s.passRule,
    examDate: s.examDate ? dateFromDb(s.examDate) : null,
    startTime: s.startTime,
    fullMarks: s.components.reduce((n, c) => n + c.fullMarks, 0),
    components: s.components.map((c) => ({
      key: c.key,
      kind: c.kind,
      nameBn: c.nameBn,
      nameEn: c.nameEn,
      fullMarks: c.fullMarks,
      passMarks: c.passMarks,
    })),
    passGroups: s.passGroups.map((g) => ({ kind: g.kind, passMarks: g.passMarks })),
  };
}

const subjectSnapshot = (v: ExamSubjectView) => ({
  passRule: v.passRule,
  examDate: v.examDate,
  startTime: v.startTime,
  components: v.components.map((c) => ({ ...c })),
  passGroups: v.passGroups.map((g) => ({ ...g })),
});

function toDetail(r: ExamRow): ExamDetail {
  return {
    id: r.id,
    academicYearId: r.academicYearId,
    kind: r.kind,
    nameBn: r.nameBn,
    nameEn: r.nameEn,
    startsOn: dateFromDb(r.startsOn),
    endsOn: dateFromDb(r.endsOn),
    resultMode: r.resultMode,
    status: r.status,
    candidates: r._count.candidates,
    meritOrder: r.meritOrder as MeritKey[],
    failedRanking: r.failedRanking,
    attendance:
      r.attendanceFrom && r.attendanceTo
        ? { from: dateFromDb(r.attendanceFrom), to: dateFromDb(r.attendanceTo) }
        : null,
    classes: [...r.classes]
      .sort((a, b) => a.classLevel.sortOrder - b.classLevel.sortOrder)
      .map((c) => ({
        id: c.id,
        classLevel: {
          id: c.classLevel.id,
          code: c.classLevel.code,
          nameBn: c.classLevel.nameBn,
          nameEn: c.classLevel.nameEn,
        },
        isPublished: c.isPublished,
        publishedVersion: c.publishedVersion,
        publishedAt: c.publishedAt?.toISOString() ?? null,
        subjects: c.subjects.map(toSubjectView),
      })),
  };
}

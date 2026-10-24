import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  ExamSectionRef,
  ExamStaffMember,
  SectionSubjectTeachersInput,
  SectionSubjectTeachersView,
  SubjectChoicesInput,
  SubjectChoicesView,
} from '@jantrik/shared';
import { AuditService } from '../../audit/audit.module.js';
import { apiError } from '../../common/api-error.js';
import { RequestContext } from '../../common/request-context.js';
import { staffNames, staffRef } from '../../staff/staff.module.js';
import { Db } from '../../tenancy/db.service.js';

/** Who may be given a subject to mark (as attendance: teachers and admins). */
export const MARKS_ROLES = ['TEACHER', 'ADMIN', 'OWNER'] as const;

/**
 * Exams setup per section (OWNER/ADMIN): the teachers who enter marks for each subject, and each
 * student's elective subjects (the 4th subject). Every write is audited.
 */
@Injectable()
export class ExamStaffService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
  ) {}

  private get tenantId(): string {
    return this.context.requirePrincipal().tenantId!;
  }

  /** Active staff who can be given subjects, highest role first. */
  async staff(): Promise<ExamStaffMember[]> {
    const rows = await this.db.tx.membership.findMany({
      where: { status: 'ACTIVE', role: { in: [...MARKS_ROLES] } },
      select: { role: true, userId: true },
    });
    const rank = { OWNER: 0, ADMIN: 1, TEACHER: 2 } as const;
    const names = await staffNames(this.db.tx, [...new Set(rows.map((r) => r.userId))]);
    const byUser = new Map<string, ExamStaffMember>();
    for (const r of rows) {
      const role = r.role as ExamStaffMember['role'];
      const seen = byUser.get(r.userId);
      if (!seen || rank[role] < rank[seen.role])
        byUser.set(r.userId, { ...staffRef(names, r.userId), role });
    }
    return [...byUser.values()].sort(
      (a, b) => rank[a.role] - rank[b.role] || a.name.localeCompare(b.name),
    );
  }

  // ─────────────────────────── Subject teachers ───────────────────────────

  async subjectTeachers(sectionId: string): Promise<SectionSubjectTeachersView> {
    const tx = this.db.tx;
    const section = await this.section(sectionId);
    const [subjects, rows, classTeacher] = await Promise.all([
      tx.subject.findMany({
        where: { classLevelId: section.classLevel.id, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
        select: {
          id: true,
          code: true,
          nameBn: true,
          nameEn: true,
          studyGroupId: true,
          isOptional: true,
        },
      }),
      tx.sectionSubjectTeacher.findMany({
        where: { sectionId },
        orderBy: { createdAt: 'asc' },
        select: { subjectId: true, userId: true },
      }),
      tx.sectionTeacher.findFirst({
        where: { sectionId, isClassTeacher: true },
        select: { userId: true },
      }),
    ]);
    const names = await staffNames(tx, [
      ...new Set([...rows.map((r) => r.userId), ...(classTeacher ? [classTeacher.userId] : [])]),
    ]);
    return {
      section,
      classTeacher: classTeacher ? staffRef(names, classTeacher.userId) : null,
      subjects: subjects.map((subject) => ({
        subject,
        teachers: rows
          .filter((r) => r.subjectId === subject.id)
          .map((r) => staffRef(names, r.userId)),
      })),
    };
  }

  /**
   * Replace the section's subject teachers. Each person must be an ACTIVE teacher or admin of this
   * institute with a staff profile (users are global, so the database cannot check it), and each
   * subject must belong to the section's class.
   */
  async setSubjectTeachers(
    sectionId: string,
    input: SectionSubjectTeachersInput,
  ): Promise<SectionSubjectTeachersView> {
    const tx = this.db.tx;
    const section = await this.section(sectionId);
    const subjectIds = input.assignments.map((a) => a.subjectId);
    const subjects = await tx.subject.findMany({
      where: { id: { in: subjectIds }, classLevelId: section.classLevel.id },
      select: { id: true },
    });
    const known = new Set(subjects.map((s) => s.id));
    const foreign = subjectIds.filter((id) => !known.has(id));
    if (foreign.length > 0) {
      throw apiError(422, 'SUBJECT_NOT_IN_CLASS', "A subject is not one of this section's class", {
        subjectIds: foreign,
      });
    }
    const userIds = [...new Set(input.assignments.flatMap((a) => a.userIds))];
    await this.assertStaff(userIds);

    const before = await this.subjectTeachers(sectionId);
    await tx.sectionSubjectTeacher.deleteMany({ where: { sectionId } });
    const tenantId = this.tenantId;
    await tx.sectionSubjectTeacher.createMany({
      data: input.assignments.flatMap((a) =>
        a.userIds.map((userId) => ({
          tenantId,
          sectionId,
          subjectId: a.subjectId,
          classLevelId: section.classLevel.id,
          userId,
        })),
      ),
    });
    const after = await this.subjectTeachers(sectionId);
    await this.audit.record({
      entity: 'section_subject_teachers',
      entityId: sectionId,
      action: 'UPDATE',
      oldValues: assignmentsOf(before),
      newValues: assignmentsOf(after),
    });
    return after;
  }

  private async assertStaff(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const tx = this.db.tx;
    const [members, profiles] = await Promise.all([
      tx.membership.findMany({
        where: { userId: { in: userIds }, status: 'ACTIVE', role: { in: [...MARKS_ROLES] } },
        select: { userId: true },
      }),
      tx.staffProfile.findMany({ where: { userId: { in: userIds } }, select: { userId: true } }),
    ]);
    const active = new Set(members.map((m) => m.userId));
    const profiled = new Set(profiles.map((p) => p.userId));
    const invalid = userIds.filter((id) => !active.has(id) || !profiled.has(id));
    if (invalid.length > 0) {
      throw apiError(422, 'NOT_STAFF', 'Only active teachers or admins can be given a subject', {
        userIds: invalid,
      });
    }
  }

  // ─────────────────────────── Subject choices ───────────────────────────

  async subjectChoices(sectionId: string): Promise<SubjectChoicesView> {
    const tx = this.db.tx;
    const section = await this.section(sectionId);
    const [pool, enrolments] = await Promise.all([
      this.pool(section.classLevel.id),
      tx.enrolment.findMany({
        where: { sectionId, student: { deletedAt: null, status: 'ACTIVE' } },
        orderBy: [{ roll: 'asc' }, { createdAt: 'asc' }],
        select: {
          roll: true,
          studyGroup: { select: { id: true, code: true, nameBn: true, nameEn: true } },
          student: { select: { id: true, studentCode: true, nameBn: true, nameEn: true } },
          subjectChoices: { select: { subjectId: true, kind: true } },
        },
      }),
    ]);
    return {
      section,
      pool,
      students: enrolments.map((e) => ({
        ...e.student,
        roll: e.roll,
        studyGroup: e.studyGroup,
        choices: e.subjectChoices,
      })),
    };
  }

  /**
   * Replace the elective choices of the students sent (others keep theirs). A choice must be an
   * active elective of the class, for every group or the student's own group.
   */
  async setSubjectChoices(
    sectionId: string,
    input: SubjectChoicesInput,
  ): Promise<SubjectChoicesView> {
    const tx = this.db.tx;
    const section = await this.section(sectionId);
    const studentIds = input.students.map((s) => s.studentId);
    const enrolments = await tx.enrolment.findMany({
      where: {
        sectionId,
        studentId: { in: studentIds },
        student: { deletedAt: null, status: 'ACTIVE' },
      },
      select: { studentId: true, studyGroupId: true },
    });
    const groupOf = new Map(enrolments.map((e) => [e.studentId, e.studyGroupId]));
    const outsiders = studentIds.filter((id) => !groupOf.has(id));
    if (outsiders.length > 0) {
      throw apiError(422, 'NOT_IN_SECTION', 'A student is not in this section', {
        studentIds: outsiders,
      });
    }
    const pool = new Map((await this.pool(section.classLevel.id)).map((p) => [p.id, p]));
    for (const s of input.students) {
      for (const c of s.choices) {
        const subject = pool.get(c.subjectId);
        if (
          !subject ||
          (subject.studyGroupId !== null && subject.studyGroupId !== groupOf.get(s.studentId))
        ) {
          throw apiError(422, 'NOT_ELECTIVE', "Not one of this student's elective subjects", {
            studentId: s.studentId,
            subjectId: c.subjectId,
          });
        }
      }
    }

    const before = await tx.studentSubjectChoice.findMany({
      where: { academicYearId: section.academicYearId, studentId: { in: studentIds } },
      select: { studentId: true, subjectId: true, kind: true },
    });
    await tx.studentSubjectChoice.deleteMany({
      where: { academicYearId: section.academicYearId, studentId: { in: studentIds } },
    });
    const tenantId = this.tenantId;
    await tx.studentSubjectChoice.createMany({
      data: input.students.flatMap((s) =>
        s.choices.map((c) => ({
          tenantId,
          academicYearId: section.academicYearId,
          studentId: s.studentId,
          subjectId: c.subjectId,
          kind: c.kind,
        })),
      ),
    });
    await this.audit.record({
      entity: 'student_subject_choices',
      entityId: sectionId,
      action: 'UPDATE',
      oldValues: before,
      newValues: input.students,
    });
    return this.subjectChoices(sectionId);
  }

  private pool(classLevelId: string) {
    return this.db.tx.subject.findMany({
      where: { classLevelId, isOptional: true, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
      select: { id: true, code: true, nameBn: true, nameEn: true, studyGroupId: true },
    });
  }

  private async section(sectionId: string): Promise<ExamSectionRef> {
    const row = await this.db.tx.section.findUnique({
      where: { id: sectionId },
      select: {
        id: true,
        name: true,
        academicYearId: true,
        classLevel: { select: { id: true, code: true, nameBn: true, nameEn: true } },
      },
    });
    if (!row) throw new NotFoundException('Section not found');
    return row;
  }
}

const assignmentsOf = (v: SectionSubjectTeachersView) =>
  v.subjects
    .filter((s) => s.teachers.length > 0)
    .map((s) => ({ subjectId: s.subject.id, userIds: s.teachers.map((t) => t.id) }));

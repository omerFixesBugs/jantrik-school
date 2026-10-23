import { Injectable } from '@nestjs/common';
import { applicableSubjects, type ExamSubjectRef } from '@jantrik/shared';
import { Db } from '../../tenancy/db.service.js';

export interface RosterStudent {
  studentId: string;
  studentCode: string;
  nameBn: string | null;
  nameEn: string | null;
  roll: number | null;
  sectionId: string;
  studyGroupId: string | null;
}

/**
 * Who sits which subject: the exam's enrolled candidates, filtered by group and elective choices
 * (`applicableSubjects`). Withdrawn candidates sit nothing.
 */
@Injectable()
export class ExamRosterService {
  constructor(private readonly db: Db) {}

  /** Every enrolled candidate of an exam (optionally one class), with their elective choices. */
  async candidates(examId: string, classLevelId?: string) {
    const tx = this.db.tx;
    const exam = await tx.exam.findUniqueOrThrow({
      where: { id: examId },
      select: { academicYearId: true },
    });
    const rows = await tx.examCandidate.findMany({
      where: {
        examId,
        status: 'ENROLLED',
        student: { deletedAt: null },
        ...(classLevelId ? { classLevelId } : {}),
      },
      orderBy: [{ roll: 'asc' }, { createdAt: 'asc' }],
      select: {
        studentId: true,
        classLevelId: true,
        sectionId: true,
        studyGroupId: true,
        roll: true,
        student: { select: { studentCode: true, nameBn: true, nameEn: true } },
      },
    });
    const choices = await tx.studentSubjectChoice.findMany({
      where: {
        academicYearId: exam.academicYearId,
        studentId: { in: rows.map((r) => r.studentId) },
      },
      select: { studentId: true, subjectId: true, kind: true },
    });
    const byStudent = new Map<string, { subjectId: string; kind: 'COMPULSORY' | 'OPTIONAL' }[]>();
    for (const c of choices) {
      const list = byStudent.get(c.studentId) ?? [];
      list.push({ subjectId: c.subjectId, kind: c.kind });
      byStudent.set(c.studentId, list);
    }
    return rows.map((r) => ({
      studentId: r.studentId,
      studentCode: r.student.studentCode,
      nameBn: r.student.nameBn,
      nameEn: r.student.nameEn,
      roll: r.roll,
      classLevelId: r.classLevelId,
      sectionId: r.sectionId,
      studyGroupId: r.studyGroupId,
      choices: byStudent.get(r.studentId) ?? [],
    }));
  }

  /** The students of one section who sit one exam subject, by roll. */
  async forSheet(
    examId: string,
    subject: ExamSubjectRef & { classLevelId: string },
    sectionId: string,
  ): Promise<RosterStudent[]> {
    const all = await this.candidates(examId, subject.classLevelId);
    return all
      .filter((c) => c.sectionId === sectionId && sits(subject, c))
      .map(({ choices: _c, classLevelId: _l, ...r }) => r);
  }
}

/** Does this candidate sit this subject? */
export function sits(
  subject: ExamSubjectRef,
  candidate: {
    studyGroupId: string | null;
    choices: { subjectId: string; kind: 'COMPULSORY' | 'OPTIONAL' }[];
  },
): boolean {
  return (
    applicableSubjects([subject], { studyGroupId: candidate.studyGroupId }, candidate.choices)
      .length > 0
  );
}

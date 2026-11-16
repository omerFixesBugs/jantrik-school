import { Injectable, Module } from '@nestjs/common';
import { Db } from '../../tenancy/db.service.js';

/**
 * Subject choices across years, for other modules (CLAUDE.md rule 4): promotion copies a
 * repeater's choices into the new year (P5-H) through this, not by writing the exams module's
 * table itself.
 */
@Injectable()
export class SubjectChoicesCopier {
  constructor(private readonly db: Db) {}

  /**
   * The students' choices of `fromYearId` among the class's still active subjects, copied into
   * `toYearId` (where each must already be enrolled). Choices already there are kept. Returns how
   * many were added.
   */
  async copyForRepeaters(
    students: { studentId: string; studyGroupId: string | null }[],
    fromYearId: string,
    toYearId: string,
    classLevelId: string,
  ): Promise<number> {
    if (students.length === 0) return 0;
    const tx = this.db.tx;
    const groupOf = new Map(students.map((s) => [s.studentId, s.studyGroupId]));
    const choices = (
      await tx.studentSubjectChoice.findMany({
        where: {
          academicYearId: fromYearId,
          studentId: { in: [...groupOf.keys()] },
          subject: { isActive: true, classLevelId },
        },
        select: {
          tenantId: true,
          studentId: true,
          subjectId: true,
          kind: true,
          subject: { select: { studyGroupId: true } },
        },
      })
    )
      // A subject of another study group than the new year's is not taken there.
      .filter(
        (c) =>
          c.subject.studyGroupId === null || c.subject.studyGroupId === groupOf.get(c.studentId),
      );
    if (choices.length === 0) return 0;
    const { count } = await tx.studentSubjectChoice.createMany({
      data: choices.map(({ subject: _subject, ...c }) => ({ ...c, academicYearId: toYearId })),
      skipDuplicates: true,
    });
    return count;
  }

  /**
   * A student's placement in a year corrected (P5): their choices of that year among subjects
   * they no longer take there (another class's, or another study group's) are removed. Returns
   * the subject ids.
   */
  async removeNotTaken(
    studentId: string,
    academicYearId: string,
    classLevelId: string,
    studyGroupId: string | null,
  ): Promise<string[]> {
    const tx = this.db.tx;
    const stale = await tx.studentSubjectChoice.findMany({
      where: {
        studentId,
        academicYearId,
        OR: [
          { subject: { classLevelId: { not: classLevelId } } },
          {
            subject: {
              studyGroupId: studyGroupId ? { not: studyGroupId } : { not: null },
            },
          },
        ],
      },
      select: { id: true, subjectId: true },
    });
    if (stale.length > 0)
      await tx.studentSubjectChoice.deleteMany({ where: { id: { in: stale.map((c) => c.id) } } });
    return stale.map((c) => c.subjectId);
  }
}

/** Subject choices across years, for promotion and students (no imports, so no cycle). */
@Module({ providers: [SubjectChoicesCopier], exports: [SubjectChoicesCopier] })
export class SubjectChoicesModule {}

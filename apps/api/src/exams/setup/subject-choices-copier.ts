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
    studentIds: string[],
    fromYearId: string,
    toYearId: string,
    classLevelId: string,
  ): Promise<number> {
    if (studentIds.length === 0) return 0;
    const tx = this.db.tx;
    const choices = await tx.studentSubjectChoice.findMany({
      where: {
        academicYearId: fromYearId,
        studentId: { in: studentIds },
        subject: { isActive: true, classLevelId },
      },
      select: { tenantId: true, studentId: true, subjectId: true, kind: true },
    });
    if (choices.length === 0) return 0;
    const { count } = await tx.studentSubjectChoice.createMany({
      data: choices.map((c) => ({ ...c, academicYearId: toYearId })),
      skipDuplicates: true,
    });
    return count;
  }

  /**
   * A student moved to another class in a year (a placement corrected, P5): their choices of that
   * year among other classes' subjects no longer apply and are removed. Returns the subject ids.
   */
  async removeOtherClasses(
    studentId: string,
    academicYearId: string,
    classLevelId: string,
  ): Promise<string[]> {
    const tx = this.db.tx;
    const stale = await tx.studentSubjectChoice.findMany({
      where: { studentId, academicYearId, subject: { classLevelId: { not: classLevelId } } },
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

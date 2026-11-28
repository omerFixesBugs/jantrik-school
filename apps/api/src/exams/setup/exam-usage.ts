import { Injectable, Module } from '@nestjs/common';
import { Db } from '../../tenancy/db.service.js';

/** Exam rosters a student is on, for other modules (CLAUDE.md rule 4). */
@Injectable()
export class ExamUsage {
  constructor(private readonly db: Db) {}

  /** Exam rosters of that year with the student on them. */
  candidatesInYear(studentId: string, academicYearId: string): Promise<number> {
    return this.db.tx.examCandidate.count({ where: { studentId, exam: { academicYearId } } });
  }
}

/** No imports, so any module may use it without a cycle. */
@Module({ providers: [ExamUsage], exports: [ExamUsage] })
export class ExamUsageModule {}

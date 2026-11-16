import { Injectable, Module } from '@nestjs/common';
import { Db } from '../tenancy/db.service.js';

/** Dues of a student, for other modules (CLAUDE.md rule 4). */
@Injectable()
export class FeeUsage {
  constructor(private readonly db: Db) {}

  /** Dues of the student in that year (any status). */
  duesInYear(studentId: string, academicYearId: string): Promise<number> {
    return this.db.tx.feeDue.count({ where: { studentId, academicYearId } });
  }
}

/** No imports, so any module may use it without a cycle. */
@Module({ providers: [FeeUsage], exports: [FeeUsage] })
export class FeeUsageModule {}

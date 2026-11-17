import { Injectable, Module } from '@nestjs/common';
import { Db } from '../tenancy/db.service.js';

/** Attendance kept for a student, for other modules (CLAUDE.md rule 4). */
@Injectable()
export class AttendanceUsage {
  constructor(private readonly db: Db) {}

  /** Attendance records of the student in registers of that year's sections. */
  recordsInYear(studentId: string, academicYearId: string): Promise<number> {
    return this.db.tx.attendanceRecord.count({
      where: { studentId, session: { section: { academicYearId } } },
    });
  }
}

/** No imports, so any module may use it without a cycle. */
@Module({ providers: [AttendanceUsage], exports: [AttendanceUsage] })
export class AttendanceUsageModule {}

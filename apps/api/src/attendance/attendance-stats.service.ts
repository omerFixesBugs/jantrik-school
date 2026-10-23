import { Injectable } from '@nestjs/common';
import {
  attendancePercent,
  dateToDb,
  type AttendanceCounts,
  type AttendanceStatus,
  type IsoDate,
} from '@jantrik/shared';
import { Db } from '../tenancy/db.service.js';
import { AttendanceSettingsService } from './attendance-settings.service.js';

export interface StudentAttendanceStats {
  counts: AttendanceCounts;
  percent: number | null;
}

const STATUS_KEY = {
  PRESENT: 'present',
  ABSENT: 'absent',
  LATE: 'late',
  LEAVE: 'leave',
} as const satisfies Record<AttendanceStatus, keyof AttendanceCounts>;

/**
 * Attendance totals for many students at once, for other modules (exam report cards). Same rule
 * as the per-student report: each day counts once, by the student's first register of that day
 * (lowest period number), and the present % follows the institute's LEAVE setting.
 */
@Injectable()
export class AttendanceStatsService {
  constructor(
    private readonly db: Db,
    private readonly settings: AttendanceSettingsService,
  ) {}

  async percentByStudent(
    studentIds: readonly string[],
    from: IsoDate,
    to: IsoDate,
  ): Promise<Map<string, StudentAttendanceStats>> {
    const out = new Map<string, StudentAttendanceStats>();
    if (studentIds.length === 0) return out;
    const { settings } = await this.settings.load();
    const rows = await this.db.tx.$queryRaw<{ student_id: string; status: AttendanceStatus }[]>`
      SELECT DISTINCT ON (r.student_id, s.date) r.student_id, r.status::text AS status
      FROM attendance_records r
      JOIN attendance_sessions s ON s.tenant_id = r.tenant_id AND s.id = r.session_id
      WHERE r.student_id = ANY(${[...studentIds]}::uuid[])
        AND s.date BETWEEN ${dateToDb(from)}::date AND ${dateToDb(to)}::date
      ORDER BY r.student_id, s.date, s.period_no`;
    for (const id of studentIds) {
      out.set(id, { counts: { present: 0, absent: 0, late: 0, leave: 0 }, percent: null });
    }
    for (const r of rows) out.get(r.student_id)!.counts[STATUS_KEY[r.status]] += 1;
    for (const stats of out.values()) {
      stats.percent = attendancePercent(stats.counts, settings.leaveCountsAsAbsent);
    }
    return out;
  }
}

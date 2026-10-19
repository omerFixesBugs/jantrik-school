import { Injectable, NotFoundException } from '@nestjs/common';
import {
  attendancePercent,
  buildRegister,
  dateFromDb,
  dateToDb,
  monthDates,
  registerCsv,
  type AttendanceCounts,
  type AttendanceRegisterReport,
  type AttendanceStaffMember,
  type AttendanceStatus,
  type AttendanceTodayReport,
  type ChildAttendanceMonth,
  type IsoDate,
  type SendHeldSmsResult,
  type StudentAttendanceReport,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import { TenantSmsService } from '../sms/tenant-sms.service.js';
import { StudentAccess } from '../students/student-access.service.js';
import { Db } from '../tenancy/db.service.js';
import { AttendanceSettingsService } from './attendance-settings.service.js';
import { AttendanceService } from './attendance.service.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const STATUS_KEY = {
  PRESENT: 'present',
  ABSENT: 'absent',
  LATE: 'late',
  LEAVE: 'leave',
} as const satisfies Record<AttendanceStatus, keyof AttendanceCounts>;

const emptyCounts = (): AttendanceCounts => ({ present: 0, absent: 0, late: 0, leave: 0 });

function countStatuses(statuses: Iterable<AttendanceStatus>): AttendanceCounts {
  const c = emptyCounts();
  for (const s of statuses) c[STATUS_KEY[s]] += 1;
  return c;
}

const CSV_LABELS = {
  bn: {
    roll: 'রোল',
    id: 'আইডি',
    name: 'নাম',
    present: 'উপস্থিত',
    absent: 'অনুপস্থিত',
    late: 'দেরি',
    leave: 'ছুটি',
    percent: 'উপস্থিতি %',
  },
  en: {
    roll: 'Roll',
    id: 'ID',
    name: 'Name',
    present: 'Present',
    absent: 'Absent',
    late: 'Late',
    leave: 'Leave',
    percent: 'Present %',
  },
} as const;

/**
 * Attendance reports. Every report uses a day's FIRST register (lowest period number) as that
 * day's roll call, like the dashboard, unless a period is asked for.
 */
@Injectable()
export class AttendanceReportsService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly settings: AttendanceSettingsService,
    private readonly attendance: AttendanceService,
    private readonly audit: AuditService,
    private readonly sms: TenantSmsService,
    private readonly studentAccess: StudentAccess,
  ) {}

  // ─────────────────────────── Today ───────────────────────────

  async today(): Promise<AttendanceTodayReport> {
    const tenant = await this.settings.load();
    const mine = await this.attendance.mySections();
    const year = await this.currentYearId();
    const scope = await this.studentAccess.scope();
    const sessions = await this.db.tx.attendanceSession.findMany({
      where: { date: dateToDb(tenant.today), sectionId: { in: mine.sections.map((s) => s.id) } },
      orderBy: { periodNo: 'asc' },
      select: {
        sectionId: true,
        periodNo: true,
        submittedAt: true,
        updatedBy: { select: { id: true, name: true, nameBn: true } },
        records: { select: { studentId: true, status: true } },
      },
    });
    const first = new Map<string, (typeof sessions)[number]>();
    for (const s of sessions) if (!first.has(s.sectionId)) first.set(s.sectionId, s);

    const totals = emptyCounts();
    const sections: AttendanceTodayReport['sections'] = [];
    for (const section of mine.sections) {
      const s = first.get(section.id);
      const ref = { id: section.id, name: section.name, classLevel: section.classLevel };
      if (!s) {
        sections.push({ section: ref, studentCount: section.studentCount, register: null });
        continue;
      }
      const counts = countStatuses(s.records.map((r) => r.status));
      for (const k of Object.keys(totals) as (keyof AttendanceCounts)[]) totals[k] += counts[k];
      const absentIds = new Set(
        s.records.filter((r) => r.status === 'ABSENT').map((r) => r.studentId),
      );
      const absentRoster =
        absentIds.size === 0
          ? []
          : (await this.attendance.roster(section.id, year)).filter((st) => absentIds.has(st.id));
      const phones = StudentAccess.sees(scope, section.id)
        ? await this.primaryPhones(absentRoster.map((st) => st.id))
        : new Map<string, string>();
      const absent = absentRoster.map((st) => ({
        ...st,
        guardianPhone: phones.get(st.id) ?? null,
      }));
      sections.push({
        section: ref,
        studentCount: section.studentCount,
        register: {
          periodNo: s.periodNo,
          submittedAt: s.submittedAt.toISOString(),
          updatedBy: s.updatedBy,
          counts,
          percent: attendancePercent(counts, tenant.settings.leaveCountsAsAbsent),
          absent,
        },
      });
    }
    return {
      today: tenant.today,
      mode: tenant.settings.mode,
      nonWorkingDay: mine.nonWorkingDay,
      leaveCountsAsAbsent: tenant.settings.leaveCountsAsAbsent,
      sections,
      totals: {
        sectionsTotal: sections.length,
        sectionsTaken: first.size,
        counts: totals,
        percent: attendancePercent(totals, tenant.settings.leaveCountsAsAbsent),
      },
    };
  }

  /** Primary guardian phone per student. */
  private async primaryPhones(studentIds: string[]): Promise<Map<string, string>> {
    if (studentIds.length === 0) return new Map();
    const rows = await this.db.tx.studentGuardian.findMany({
      where: { studentId: { in: studentIds }, isPrimary: true },
      select: { studentId: true, guardian: { select: { phone: true } } },
    });
    return new Map(rows.map((r) => [r.studentId, r.guardian.phone]));
  }

  // ─────────────────────────── Monthly register ───────────────────────────

  async register(query: {
    sectionId: string;
    month: string;
    periodNo?: number;
  }): Promise<AttendanceRegisterReport> {
    const tenant = await this.settings.load();
    const caller = await this.attendance.caller();
    const section = await this.attendance.currentSection(query.sectionId);
    await this.attendance.assertMayMark(section.id, caller);
    const periodNo = tenant.settings.mode === 'DAILY' ? 0 : (query.periodNo ?? null);

    const dates = monthDates(query.month);
    const from = dates[0]!;
    const to = dates.at(-1)!;
    const sessions = await this.db.tx.attendanceSession.findMany({
      where: {
        sectionId: section.id,
        date: { gte: dateToDb(from), lte: dateToDb(to) },
        ...(periodNo === null ? {} : { periodNo }),
      },
      orderBy: [{ date: 'asc' }, { periodNo: 'asc' }],
      select: { date: true, records: { select: { studentId: true, status: true } } },
    });
    const byDate = new Map<IsoDate, (typeof sessions)[number]>();
    for (const s of sessions) {
      const d = dateFromDb(s.date);
      if (!byDate.has(d)) byDate.set(d, s); // the day's first register
    }
    const register = buildRegister({
      month: query.month,
      students: await this.attendance.roster(section.id, section.academicYearId),
      takenDates: [...byDate.keys()],
      records: [...byDate].flatMap(([date, s]) =>
        s.records.map((r) => ({ studentId: r.studentId, date, status: r.status })),
      ),
      nonWorking: await this.settings.nonWorkingDays(from, to, tenant.settings),
      leaveCountsAsAbsent: tenant.settings.leaveCountsAsAbsent,
    });
    return {
      ...register,
      today: tenant.today,
      mode: tenant.settings.mode,
      periodNo,
      section: section.ref,
      leaveCountsAsAbsent: tenant.settings.leaveCountsAsAbsent,
    };
  }

  async registerCsv(query: {
    sectionId: string;
    month: string;
    periodNo?: number;
    locale: 'bn' | 'en';
  }): Promise<{ filename: string; csv: string }> {
    const report = await this.register(query);
    // ASCII only: the browser download names the file itself; this is the fallback.
    const filename = `attendance-${report.month}.csv`;
    return { filename, csv: registerCsv(report, query.locale, CSV_LABELS[query.locale]) };
  }

  // ─────────────────────────── One student ───────────────────────────

  async student(studentId: string, from: IsoDate, to: IsoDate): Promise<StudentAttendanceReport> {
    const tenant = await this.settings.load();
    const caller = await this.attendance.caller();
    const year = await this.currentYearId();
    const student = await this.db.tx.student.findFirst({
      where: { id: studentId, deletedAt: null },
      select: {
        id: true,
        studentCode: true,
        nameBn: true,
        nameEn: true,
        enrolments: {
          where: { academicYearId: year },
          take: 1,
          select: {
            roll: true,
            section: {
              select: {
                id: true,
                name: true,
                classLevel: { select: { id: true, nameBn: true, nameEn: true } },
              },
            },
          },
        },
      },
    });
    if (!student) throw new NotFoundException('Student not found');
    const enrolment = student.enrolments[0] ?? null;
    const section = enrolment?.section ?? null;
    if (!caller.isAdmin) {
      // Teachers: only students of a section they take attendance for.
      if (!section) {
        throw apiError(403, 'NOT_ASSIGNED', 'You are not assigned to this student’s section');
      }
      await this.attendance.assertMayMark(section.id, caller);
    }

    const days = await this.studentDays(studentId, from, to);
    const counts = countStatuses(days.map((d) => d.status));
    const sectionDates = section
      ? await this.db.tx.attendanceSession.findMany({
          where: {
            sectionId: section.id,
            date: { gte: dateToDb(from), lte: dateToDb(to) },
          },
          distinct: ['date'],
          select: { date: true },
        })
      : [];
    const nonWorking = await this.settings.nonWorkingDays(from, to, tenant.settings);
    return {
      student: {
        id: student.id,
        studentCode: student.studentCode,
        nameBn: student.nameBn,
        nameEn: student.nameEn,
        roll: enrolment?.roll ?? null,
        section,
      },
      from,
      to,
      leaveCountsAsAbsent: tenant.settings.leaveCountsAsAbsent,
      daysTaken: sectionDates.length,
      counts,
      percent: attendancePercent(counts, tenant.settings.leaveCountsAsAbsent),
      days: [...days].reverse().map((d) => ({ ...d, nonWorkingDay: nonWorking[d.date] ?? null })),
    };
  }

  // ─────────────────────────── Guardian ───────────────────────────

  /** A guardian's own child only (guardian.userId = caller); 404 for anyone else's. */
  async childMonth(studentId: string, month?: string): Promise<ChildAttendanceMonth> {
    const tenant = await this.settings.load();
    const userId = this.context.requirePrincipal().userId;
    const link = await this.db.tx.studentGuardian.findFirst({
      where: { studentId, guardian: { userId }, student: { deletedAt: null } },
      select: { id: true },
    });
    if (!link) throw new NotFoundException('Child not found');

    const m = month ?? tenant.today.slice(0, 7);
    const dates = monthDates(m);
    const from = dates[0]!;
    const to = dates.at(-1)!;
    const records = new Map(
      (await this.studentDays(studentId, from, to)).map((d) => [d.date, d.status]),
    );
    const nonWorking = await this.settings.nonWorkingDays(from, to, tenant.settings);
    const counts = countStatuses(records.values());
    return {
      today: tenant.today,
      month: m,
      leaveCountsAsAbsent: tenant.settings.leaveCountsAsAbsent,
      days: dates.map((date) => ({
        date,
        status: records.get(date) ?? null,
        nonWorkingDay: nonWorking[date] ?? null,
      })),
      counts,
      percent: attendancePercent(counts, tenant.settings.leaveCountsAsAbsent),
    };
  }

  // ─────────────────────────── Admin ───────────────────────────

  /** Active staff who can take attendance (for assigning sections). */
  async staff(): Promise<AttendanceStaffMember[]> {
    const rows = await this.db.tx.membership.findMany({
      where: { status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN', 'TEACHER'] } },
      select: { role: true, user: { select: { id: true, name: true, nameBn: true } } },
    });
    const rank = { OWNER: 0, ADMIN: 1, TEACHER: 2 } as const;
    const byUser = new Map<string, AttendanceStaffMember>();
    for (const r of rows) {
      const role = r.role as AttendanceStaffMember['role'];
      const seen = byUser.get(r.user.id);
      if (!seen || rank[role] < rank[seen.role]) byUser.set(r.user.id, { ...r.user, role });
    }
    return [...byUser.values()].sort(
      (a, b) => rank[a.role] - rank[b.role] || a.name.localeCompare(b.name),
    );
  }

  /** Send today's SMS that were held back by the daily cap (after the admin confirms). */
  async sendHeld(): Promise<SendHeldSmsResult> {
    const tenant = await this.settings.load();
    const { queued, cancelled } = await this.sms.releaseHeld(tenant.today);
    if (queued.length + cancelled.length > 0) {
      await this.audit.record({
        entity: 'sms_logs',
        entityId: tenant.id,
        action: 'UPDATE',
        newValues: { releasedHeld: tenant.today, queued, cancelled },
      });
    }
    return { queued: queued.length, cancelled: cancelled.length };
  }

  // ─────────────────────────── Data ───────────────────────────

  /** The student's status on each day's first register, oldest first. */
  private async studentDays(
    studentId: string,
    from: IsoDate,
    to: IsoDate,
  ): Promise<{ date: IsoDate; status: AttendanceStatus }[]> {
    const rows = await this.db.tx.attendanceRecord.findMany({
      where: { studentId, session: { date: { gte: dateToDb(from), lte: dateToDb(to) } } },
      orderBy: [{ session: { date: 'asc' } }, { session: { periodNo: 'asc' } }],
      select: { status: true, session: { select: { date: true } } },
    });
    const out: { date: IsoDate; status: AttendanceStatus }[] = [];
    for (const r of rows) {
      const date = dateFromDb(r.session.date);
      if (out.at(-1)?.date !== date) out.push({ date, status: r.status });
    }
    return out;
  }

  private async currentYearId(): Promise<string> {
    const year = await this.db.tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    return year?.id ?? NIL_UUID;
  }
}

import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@jantrik/db';
import {
  addDays,
  attendancePercent,
  DEFAULT_ABSENT_SMS_TEMPLATE,
  dateToDb,
  formatDate,
  renderSmsTemplate,
  type AttendanceSessionState,
  type AttendanceSheet,
  type AttendanceStatus,
  type AttendanceTodaySummary,
  type IsoDate,
  type MySectionsResponse,
  type RosterStudent,
  type SectionRef,
  type SmsDailyStatus,
  type SubmitAttendanceResponse,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import { TenantSmsService } from '../sms/tenant-sms.service.js';
import { Db } from '../tenancy/db.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';
import {
  AttendanceSettingsService,
  type AttendanceTenant,
  type StoredSettings,
} from './attendance-settings.service.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface SubmitInput {
  sectionId: string;
  date: IsoDate;
  periodNo: number;
  subjectId?: string | null;
  submissionId: string;
  baseVersion: number;
  allowNonWorkingDay?: boolean;
  records: { studentId: string; status: AttendanceStatus; note?: string | null }[];
}

interface Caller {
  userId: string;
  isAdmin: boolean;
}

/** Whether the caller may submit for `date`, and whether it is an admin edit past the window. */
interface DateAccess {
  allowed: boolean;
  blockedReason: 'FUTURE_DATE' | 'EDIT_WINDOW_CLOSED' | null;
  lateEdit: boolean;
}

@Injectable()
export class AttendanceService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly access: TenantAccessService,
    private readonly settings: AttendanceSettingsService,
    private readonly audit: AuditService,
    private readonly sms: TenantSmsService,
  ) {}

  /** Just before an absent SMS goes out: is the student still absent in some register that day? */
  onModuleInit(): void {
    this.sms.registerRelevanceCheck('ATTENDANCE_ABSENT', async ({ relatedId, localDate }) => {
      if (!relatedId) return false;
      const absent = await this.db.tx.attendanceRecord.count({
        where: { studentId: relatedId, status: 'ABSENT', session: { date: dateToDb(localDate) } },
      });
      return absent > 0;
    });
  }

  // ─────────────────────────── Reads ───────────────────────────

  async mySections(date?: IsoDate): Promise<MySectionsResponse> {
    const tenant = await this.settings.load();
    const caller = await this.caller();
    const day = date ?? tenant.today;
    const year = await this.currentYear();
    const assignments = await this.db.tx.sectionTeacher.findMany({
      where: { userId: caller.userId, section: { academicYearId: year?.id ?? NIL_UUID } },
      select: { sectionId: true, isClassTeacher: true },
    });
    const assigned = new Map(assignments.map((a) => [a.sectionId, a.isClassTeacher]));

    const sections = await this.db.tx.section.findMany({
      where: {
        academicYearId: year?.id ?? NIL_UUID,
        ...(caller.isAdmin ? {} : { id: { in: [...assigned.keys()] } }),
      },
      orderBy: [{ classLevel: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        classLevel: { select: { id: true, nameBn: true, nameEn: true } },
        _count: { select: { enrolments: { where: { student: { deletedAt: null } } } } },
        attendanceSessions: {
          where: { date: dateToDb(day) },
          orderBy: { periodNo: 'asc' },
          select: { periodNo: true, version: true, submittedAt: true },
        },
      },
    });
    return {
      today: tenant.today,
      date: day,
      mode: tenant.settings.mode,
      nonWorkingDay: await this.settings.nonWorkingDay(day, tenant.settings),
      sections: sections.map((s) => ({
        id: s.id,
        name: s.name,
        classLevel: s.classLevel,
        isClassTeacher: assigned.get(s.id) ?? false,
        studentCount: s._count.enrolments,
        sessions: s.attendanceSessions.map((x) => ({
          periodNo: x.periodNo,
          version: x.version,
          submittedAt: x.submittedAt.toISOString(),
        })),
      })),
    };
  }

  async sheet(query: {
    sectionId: string;
    date?: IsoDate;
    periodNo: number;
  }): Promise<AttendanceSheet> {
    const tenant = await this.settings.load();
    const caller = await this.caller();
    const date = query.date ?? tenant.today;
    const section = await this.currentSection(query.sectionId);
    await this.assertMayMark(section.id, caller);
    const dateAccess = this.dateAccess(date, tenant, caller);
    const nonWorkingDay = await this.settings.nonWorkingDay(date, tenant.settings);
    const blockedReason =
      dateAccess.blockedReason ?? (nonWorkingDay && !caller.isAdmin ? 'NON_WORKING_DAY' : null);
    return {
      today: tenant.today,
      date,
      periodNo: query.periodNo,
      mode: tenant.settings.mode,
      section: section.ref,
      nonWorkingDay,
      canSubmit: blockedReason === null,
      blockedReason,
      students: await this.roster(section.id, section.academicYearId),
      session: await this.sessionState(section.id, date, query.periodNo),
    };
  }

  async todaySummary(): Promise<AttendanceTodaySummary> {
    const tenant = await this.settings.load();
    const mine = await this.mySections();
    const counts = { present: 0, absent: 0, late: 0, leave: 0 };
    let taken = 0;
    for (const section of mine.sections) {
      const first = section.sessions[0]; // lowest period number: the day's roll call
      if (!first) continue;
      taken += 1;
      const rows = await this.db.tx.attendanceRecord.groupBy({
        by: ['status'],
        where: {
          session: {
            sectionId: section.id,
            date: dateToDb(tenant.today),
            periodNo: first.periodNo,
          },
        },
        _count: { _all: true },
      });
      for (const r of rows) counts[STATUS_KEY[r.status]] += r._count._all;
    }
    return {
      today: tenant.today,
      sectionsTotal: mine.sections.length,
      sectionsTaken: taken,
      students: counts.present + counts.absent + counts.late + counts.leave,
      counts,
      percent: attendancePercent(counts, tenant.settings.leaveCountsAsAbsent),
      everTaken: (await this.db.tx.attendanceSession.findFirst({ select: { id: true } })) !== null,
    };
  }

  async smsToday(): Promise<SmsDailyStatus> {
    const tenant = await this.settings.load();
    const counts = await this.sms.dailyCounts(tenant.today);
    return {
      date: tenant.today,
      cap: await this.settings.effectiveDailySmsCap(tenant.settings),
      ...counts,
    };
  }

  // ─────────────────────────── Submit ───────────────────────────

  async submit(input: SubmitInput): Promise<SubmitAttendanceResponse> {
    const tx = this.db.tx;
    const tenant = await this.settings.load();
    const caller = await this.caller();
    const section = await this.currentSection(input.sectionId);
    await this.assertMayMark(section.id, caller);
    this.assertPeriodFitsMode(input.periodNo, tenant.settings);
    if (input.subjectId) await this.assertSubject(input.subjectId, section.classLevelId);

    const dateAccess = this.dateAccess(input.date, tenant, caller);
    if (!dateAccess.allowed) {
      throw dateAccess.blockedReason === 'FUTURE_DATE'
        ? apiError(422, 'FUTURE_DATE', 'Attendance cannot be taken for a future date', {
            today: tenant.today,
          })
        : apiError(403, 'EDIT_WINDOW_CLOSED', 'Only an admin can change attendance for this date', {
            today: tenant.today,
          });
    }
    const nonWorkingDay = await this.settings.nonWorkingDay(input.date, tenant.settings);
    if (nonWorkingDay && !(caller.isAdmin && input.allowNonWorkingDay)) {
      throw apiError(422, 'NON_WORKING_DAY', 'No attendance on this day', { nonWorkingDay });
    }

    // Exactly the students enrolled in this section this year.
    const roster = await this.roster(section.id, section.academicYearId);
    const rosterIds = new Set(roster.map((s) => s.id));
    const unknown = input.records
      .filter((r) => !rosterIds.has(r.studentId))
      .map((r) => r.studentId);
    if (unknown.length > 0) {
      throw apiError(422, 'UNKNOWN_STUDENT', 'Some students are not enrolled in this section', {
        studentIds: unknown,
      });
    }
    if (input.records.length !== roster.length) {
      throw apiError(409, 'ROSTER_CHANGED', 'The student list has changed', { students: roster });
    }

    // Lock the register (if it exists) so two submits for it are applied one after the other.
    const date = dateToDb(input.date);
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM attendance_sessions
      WHERE section_id = ${section.id}::uuid AND date = ${date}::date AND period_no = ${input.periodNo}
      FOR UPDATE`;
    const now = new Date();
    const next = new Map(
      input.records.map((r) => [r.studentId, { status: r.status, note: r.note ?? null }]),
    );

    if (locked) {
      const current = (await this.sessionState(section.id, input.date, input.periodNo))!;
      if (await this.isReplay(locked.id, input.submissionId)) {
        return { today: tenant.today, session: current, replayed: true };
      }
      if (current.version !== input.baseVersion) {
        throw apiError(409, 'VERSION_CONFLICT', 'Someone else changed this attendance', {
          session: current,
        });
      }
      const before = new Map(current.records.map((r) => [r.studentId, r]));
      const changed = [...next].filter(([id, n]) => {
        const b = before.get(id);
        return !b || b.status !== n.status || b.note !== n.note;
      });
      for (const [studentId, n] of changed) {
        await tx.attendanceRecord.update({
          where: {
            tenantId_sessionId_studentId: { tenantId: tenant.id, sessionId: locked.id, studentId },
          },
          data: { status: n.status, note: n.note },
        });
      }
      await tx.attendanceSession.update({
        where: { id: locked.id },
        data: {
          lastSubmissionId: input.submissionId,
          ...(changed.length > 0
            ? { version: { increment: 1 }, updatedById: caller.userId, submittedAt: now }
            : {}),
        },
      });
      if (changed.length > 0) {
        await this.audit.record({
          entity: 'attendance_session',
          entityId: locked.id,
          action: 'UPDATE',
          oldValues: Object.fromEntries(changed.map(([id]) => [id, statusJson(before.get(id))])),
          newValues: {
            ...Object.fromEntries(changed.map(([id, n]) => [id, statusJson(n)])),
            lateEdit: dateAccess.lateEdit,
          },
        });
      }
    } else {
      let sessionId: string;
      try {
        const created = await tx.attendanceSession.create({
          data: {
            tenantId: tenant.id,
            sectionId: section.id,
            date,
            periodNo: input.periodNo,
            subjectId: input.subjectId ?? null,
            takenById: caller.userId,
            updatedById: caller.userId,
            submittedAt: now,
            lastSubmissionId: input.submissionId,
            onNonWorkingDay: nonWorkingDay !== null,
          },
          select: { id: true },
        });
        sessionId = created.id;
      } catch (error) {
        // Another submit created this register a moment ago: the client reloads and retries.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw apiError(409, 'VERSION_CONFLICT', 'Someone else just took this attendance', {
            session: null,
          });
        }
        throw error;
      }
      await tx.attendanceRecord.createMany({
        data: [...next].map(([studentId, n]) => ({
          tenantId: tenant.id,
          sessionId,
          studentId,
          status: n.status,
          note: n.note,
        })),
      });
      await this.audit.record({
        entity: 'attendance_session',
        entityId: sessionId,
        action: 'CREATE',
        newValues: {
          sectionId: section.id,
          date: input.date,
          periodNo: input.periodNo,
          records: Object.fromEntries([...next].map(([id, n]) => [id, statusJson(n)])),
          lateEdit: dateAccess.lateEdit,
          onNonWorkingDay: nonWorkingDay !== null,
        },
      });
    }

    const absent = [...next].filter(([, n]) => n.status === 'ABSENT').map(([id]) => id);
    await this.queueAbsentSms(tenant, input.date, absent);

    const session = (await this.sessionState(section.id, input.date, input.periodNo))!;
    return { today: tenant.today, session, replayed: false };
  }

  /**
   * One SMS per absent student per day to the primary guardian (sms_logs dedupe key), only for
   * today's registers, and only when the tenant has turned absent SMS on.
   */
  private async queueAbsentSms(tenant: AttendanceTenant, date: IsoDate, studentIds: string[]) {
    const s = tenant.settings;
    if (!s.absentSmsEnabled || date !== tenant.today || studentIds.length === 0) return;
    const students = await this.db.tx.student.findMany({
      where: { id: { in: studentIds } },
      select: {
        id: true,
        nameBn: true,
        nameEn: true,
        guardians: {
          where: { isPrimary: true },
          take: 1,
          select: { guardian: { select: { phone: true } } },
        },
      },
    });
    const template = s.absentSmsTemplate ?? DEFAULT_ABSENT_SMS_TEMPLATE;
    const cap = await this.settings.effectiveDailySmsCap(s);
    const dateText = formatDate(dateToDb(date), 'bn', 'long');
    for (const st of students) {
      const phone = st.guardians[0]?.guardian.phone;
      if (!phone) continue;
      await this.sms.queue({
        purpose: 'ATTENDANCE_ABSENT',
        phone,
        body: renderSmsTemplate(template, {
          student: st.nameBn ?? st.nameEn ?? '',
          date: dateText,
          institute: tenant.name,
        }),
        localDate: date,
        dedupeKey: `absent:${st.id}:${date}`,
        relatedEntity: 'student',
        relatedId: st.id,
        delayMs: s.absentSmsDelayMinutes * 60_000,
        dailyCap: cap,
      });
    }
  }

  // ─────────────────────────── Rules ───────────────────────────

  private async caller(): Promise<Caller> {
    const p = this.context.requirePrincipal();
    const roles = await this.access.getRoles(p.tenantId!, p.userId);
    return { userId: p.userId, isAdmin: roles.includes('OWNER') || roles.includes('ADMIN') };
  }

  private currentYear() {
    return this.db.tx.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true } });
  }

  private async currentSection(sectionId: string): Promise<{
    id: string;
    academicYearId: string;
    classLevelId: string;
    ref: SectionRef;
  }> {
    const section = await this.db.tx.section.findUnique({
      where: { id: sectionId },
      select: {
        id: true,
        name: true,
        academicYearId: true,
        classLevelId: true,
        academicYear: { select: { isCurrent: true } },
        classLevel: { select: { id: true, nameBn: true, nameEn: true } },
      },
    });
    if (!section) throw new NotFoundException('Section not found');
    if (!section.academicYear.isCurrent) {
      throw apiError(
        422,
        'SECTION_NOT_CURRENT',
        'This section is not in the current academic year',
      );
    }
    return {
      id: section.id,
      academicYearId: section.academicYearId,
      classLevelId: section.classLevelId,
      ref: { id: section.id, name: section.name, classLevel: section.classLevel },
    };
  }

  /** Teachers mark only their assigned sections; OWNER/ADMIN any. */
  private async assertMayMark(sectionId: string, caller: Caller): Promise<void> {
    if (caller.isAdmin) return;
    const assigned = await this.db.tx.sectionTeacher.findFirst({
      where: { sectionId, userId: caller.userId },
      select: { id: true },
    });
    if (!assigned) {
      throw apiError(
        403,
        'NOT_ASSIGNED',
        'You are not assigned to take attendance for this section',
      );
    }
  }

  private assertPeriodFitsMode(periodNo: number, s: StoredSettings): void {
    const ok = s.mode === 'DAILY' ? periodNo === 0 : periodNo >= 1;
    if (!ok) {
      throw apiError(
        422,
        'WRONG_PERIOD_FOR_MODE',
        `Mode ${s.mode} does not allow period ${periodNo}`,
      );
    }
  }

  private async assertSubject(subjectId: string, classLevelId: string): Promise<void> {
    const subject = await this.db.tx.subject.findFirst({
      where: { id: subjectId, classLevelId },
      select: { id: true },
    });
    if (!subject) throw apiError(422, 'UNKNOWN_SUBJECT', 'Subject not taught in this class');
  }

  /**
   * Never in the future. Teachers: from `today − editWindowDays` to today. OWNER/ADMIN: any past
   * date; outside the window it is a late edit (flagged in the audit log).
   */
  private dateAccess(date: IsoDate, tenant: AttendanceTenant, caller: Caller): DateAccess {
    if (date > tenant.today)
      return { allowed: false, blockedReason: 'FUTURE_DATE', lateEdit: false };
    const outside = date < addDays(tenant.today, -tenant.settings.editWindowDays);
    if (!outside) return { allowed: true, blockedReason: null, lateEdit: false };
    return caller.isAdmin
      ? { allowed: true, blockedReason: null, lateEdit: true }
      : { allowed: false, blockedReason: 'EDIT_WINDOW_CLOSED', lateEdit: false };
  }

  // ─────────────────────────── Data ───────────────────────────

  /** Students enrolled in the section this year, by roll. Only what the register needs. */
  private async roster(sectionId: string, academicYearId: string): Promise<RosterStudent[]> {
    const enrolments = await this.db.tx.enrolment.findMany({
      where: { sectionId, academicYearId, student: { deletedAt: null } },
      orderBy: [{ roll: { sort: 'asc', nulls: 'last' } }, { student: { studentCode: 'asc' } }],
      select: {
        roll: true,
        student: { select: { id: true, studentCode: true, nameBn: true, nameEn: true } },
      },
    });
    return enrolments.map((e) => ({ ...e.student, roll: e.roll }));
  }

  private async sessionState(
    sectionId: string,
    date: IsoDate,
    periodNo: number,
  ): Promise<AttendanceSessionState | null> {
    const s = await this.db.tx.attendanceSession.findUnique({
      where: {
        tenantId_sectionId_date_periodNo: {
          tenantId: this.context.requirePrincipal().tenantId!,
          sectionId,
          date: dateToDb(date),
          periodNo,
        },
      },
      select: {
        id: true,
        version: true,
        submittedAt: true,
        updatedBy: { select: { id: true, name: true, nameBn: true } },
        records: { select: { studentId: true, status: true, note: true } },
      },
    });
    if (!s) return null;
    return {
      id: s.id,
      version: s.version,
      submittedAt: s.submittedAt.toISOString(),
      updatedBy: s.updatedBy,
      records: s.records,
    };
  }

  private async isReplay(sessionId: string, submissionId: string): Promise<boolean> {
    const s = await this.db.tx.attendanceSession.findUnique({
      where: { id: sessionId },
      select: { lastSubmissionId: true },
    });
    return s?.lastSubmissionId === submissionId;
  }
}

const STATUS_KEY = {
  PRESENT: 'present',
  ABSENT: 'absent',
  LATE: 'late',
  LEAVE: 'leave',
} as const satisfies Record<AttendanceStatus, keyof AttendanceTodaySummary['counts']>;

const statusJson = (r: { status: AttendanceStatus; note: string | null } | undefined) =>
  r ? (r.note ? { status: r.status, note: r.note } : r.status) : null;

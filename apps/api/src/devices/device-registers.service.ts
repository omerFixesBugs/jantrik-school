import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import {
  closeDecision,
  cutoffTime,
  dateToDb,
  type AttendanceCounts,
  type CloseFromDeviceResult,
  type IsoDate,
} from '@jantrik/shared';
import { AbsentSmsService } from '../attendance/absent-sms.service.js';
import {
  AttendanceSettingsService,
  type AttendanceTenant,
} from '../attendance/attendance-settings.service.js';
import {
  DeviceArrivalsService,
  cutoffPassed,
  startOf,
  type SectionDeviceDay,
} from '../attendance/device-arrivals.service.js';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { Clock } from '../common/clock.js';
import { Db } from '../tenancy/db.service.js';
import { DeviceAttendanceService } from './device-attendance.service.js';

/** A register written from the device. */
interface WrittenRegister {
  sessionId: string;
  counts: AttendanceCounts;
  absent: string[];
}

/**
 * Registers written from device punches (DAILY mode, period 0): at each shift's cutoff by the
 * minute tick, or by an admin closing a held-back section. Both hold the institute's punch lock,
 * write every register first and queue the absent SMS last, so the SMS lock is never held while
 * waiting for a register a teacher's submit holds.
 */
@Injectable()
export class DeviceRegistersService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly settings: AttendanceSettingsService,
    private readonly arrivals: DeviceArrivalsService,
    private readonly deviceAttendance: DeviceAttendanceService,
    private readonly audit: AuditService,
    private readonly absentSms: AbsentSmsService,
  ) {}

  /**
   * The cutoff, in the institute's job transaction. In DAILY mode with auto-mark on, on a working
   * day, every current-year section with students and no register today whose shift's cutoff has
   * passed is closed when `closeDecision` says CLOSE; one held back gets nothing (the today report
   * says why, live). Returns how many registers were written.
   */
  async cutoff(): Promise<number> {
    const tenant = await this.settings.load();
    const s = tenant.settings;
    if (s.mode !== 'DAILY' || !s.deviceAutoMark) return 0;
    if (await this.settings.nonWorkingDay(tenant.today, s)) return 0;
    await this.deviceAttendance.lockPunches();
    const now = this.clock.now();
    const open = await this.db.tx.section.findMany({
      where: {
        academicYear: { isCurrent: true },
        attendanceSessions: { none: { date: dateToDb(tenant.today), periodNo: 0 } },
      },
      select: { id: true, shift: { select: { startTime: true } } },
    });
    // Punches are read only for sections whose cutoff has passed.
    const due = open.filter((section) =>
      cutoffPassed(
        cutoffTime(startOf(section.shift, tenant), s.deviceCutoffMinutes),
        now,
        tenant.timezone,
      ),
    );
    if (due.length === 0) return 0;
    const days = await this.arrivals.sectionDays(
      due.map((section) => section.id),
      tenant.today,
      tenant,
    );
    const seen = await this.arrivals.devicesSeenRecently(now);
    const absent: string[] = [];
    let written = 0;
    for (const [sectionId, day] of days) {
      const decision = closeDecision({
        cutoffPassed: true,
        devicesSeenRecently: seen,
        enrolled: day.students.length,
        arrived: day.arrivals.size,
      });
      if (decision !== 'CLOSE') continue;
      const register = await this.write(tenant, sectionId, day, now);
      if (!register) continue;
      written += 1;
      absent.push(...register.absent);
    }
    await this.absentSms.queue(tenant, tenant.today, absent);
    return written;
  }

  /**
   * An admin closes a held-back section's register from the device, after a confirm: the safety
   * rules of `closeDecision` do not apply, the cutoff does. Same register as the cutoff writes,
   * with the admin as the audit's actor and still no taker.
   */
  async closeFromDevice(sectionId: string): Promise<CloseFromDeviceResult> {
    const tenant = await this.settings.load();
    const s = tenant.settings;
    const section = await this.db.tx.section.findFirst({
      where: { id: sectionId, academicYear: { isCurrent: true } },
      select: { id: true },
    });
    if (!section) throw new NotFoundException('Section not found');
    if (s.mode !== 'DAILY') {
      throw apiError(
        422,
        'WRONG_PERIOD_FOR_MODE',
        'Registers are written from devices in DAILY mode only',
      );
    }
    const nonWorkingDay = await this.settings.nonWorkingDay(tenant.today, s);
    if (nonWorkingDay) {
      throw apiError(422, 'NON_WORKING_DAY', 'No attendance on this day', { nonWorkingDay });
    }
    await this.deviceAttendance.lockPunches();
    if (await this.registerExists(section.id, tenant.today)) throw registerExists();
    const day = (await this.arrivals.sectionDays([section.id], tenant.today, tenant)).get(
      section.id,
    )!;
    const now = this.clock.now();
    if (!cutoffPassed(day.cutoff, now, tenant.timezone)) {
      throw apiError(409, 'BEFORE_CUTOFF', 'This register closes at its cutoff', {
        cutoffAt: day.cutoff.slice(0, 5),
      });
    }
    if (day.students.length === 0) {
      throw apiError(422, 'NO_STUDENTS', 'Nobody is enrolled in this section');
    }
    const register = await this.write(tenant, section.id, day, now);
    if (!register) throw registerExists();
    await this.absentSms.queue(tenant, tenant.today, register.absent);
    return {
      sessionId: register.sessionId,
      submittedAt: now.toISOString(),
      counts: register.counts,
    };
  }

  /**
   * Today's period-0 register for the section from its punches: every roster student, those who
   * arrived PRESENT or LATE, the others ABSENT, all DEVICE, with no taker; audited. Null when a
   * register exists already: a person's submit got there first, and theirs stands.
   */
  private async write(
    tenant: AttendanceTenant,
    sectionId: string,
    day: SectionDeviceDay,
    now: Date,
  ): Promise<WrittenRegister | null> {
    const tx = this.db.tx;
    // ON CONFLICT DO NOTHING: a unique violation would abort the whole transaction.
    const [session] = await tx.attendanceSession.createManyAndReturn({
      data: [
        {
          tenantId: tenant.id,
          sectionId,
          date: dateToDb(tenant.today),
          periodNo: 0,
          source: 'DEVICE',
          submittedAt: now,
          lastSubmissionId: randomUUID(),
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    if (!session) return null;
    const statuses = day.students.map(
      (id) => [id, day.arrivals.get(id)?.status ?? 'ABSENT'] as const,
    );
    await tx.attendanceRecord.createMany({
      data: statuses.map(([studentId, status]) => ({
        tenantId: tenant.id,
        sessionId: session.id,
        studentId,
        status,
        source: 'DEVICE' as const,
      })),
    });
    await this.audit.record({
      entity: 'attendance_session',
      entityId: session.id,
      action: 'CREATE',
      newValues: {
        sectionId,
        date: tenant.today,
        periodNo: 0,
        source: 'DEVICE',
        records: Object.fromEntries(statuses),
      },
    });
    const counts: AttendanceCounts = { present: 0, absent: 0, late: 0, leave: 0 };
    for (const [, status] of statuses) {
      if (status === 'PRESENT') counts.present += 1;
      else if (status === 'LATE') counts.late += 1;
      else counts.absent += 1;
    }
    return {
      sessionId: session.id,
      counts,
      absent: statuses.filter(([, status]) => status === 'ABSENT').map(([id]) => id),
    };
  }

  private async registerExists(sectionId: string, date: IsoDate): Promise<boolean> {
    const found = await this.db.tx.attendanceSession.findFirst({
      where: { sectionId, date: dateToDb(date), periodNo: 0 },
      select: { id: true },
    });
    return found !== null;
  }
}

const registerExists = () =>
  apiError(409, 'REGISTER_EXISTS', "Today's register for this section exists already");

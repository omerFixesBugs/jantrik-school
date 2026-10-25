import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import {
  autoCloseEnd,
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
  /**
   * Who gets the absent SMS: the ABSENT students who are ACTIVE. An inactive student still
   * enrolled is written ABSENT (the roster), but the device sends their guardian nothing.
   */
  absent: string[];
}

/**
 * Registers written from device punches (DAILY mode, period 0): at each shift's cutoff by the
 * minute tick, one section per transaction, or by an admin closing a held-back section. Each
 * holds the institute's punch lock, writes the register, and queues its absent SMS last, so the
 * SMS lock is never held while waiting for a register a teacher's submit holds.
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
   * The sections the cutoff should look at now (a plain read, no lock): in DAILY mode with
   * auto-mark on, on a working day, the current-year sections with no register today whose shift's
   * cutoff has passed and whose auto-close hour has not. Each is then closed in its own
   * transaction (`closeAtCutoff`), which checks again under the lock.
   */
  async dueSections(): Promise<string[]> {
    const tenant = await this.settings.load();
    const s = tenant.settings;
    if (s.mode !== 'DAILY' || !s.deviceAutoMark) return [];
    if (await this.settings.nonWorkingDay(tenant.today, s)) return [];
    const now = this.clock.now();
    const open = await this.db.tx.section.findMany({
      where: {
        academicYear: { isCurrent: true },
        attendanceSessions: { none: { date: dateToDb(tenant.today), periodNo: 0 } },
      },
      orderBy: { id: 'asc' },
      select: { id: true, shift: { select: { startTime: true } } },
    });
    return open
      .filter((section) => {
        const start = startOf(section.shift, tenant);
        return (
          cutoffPassed(cutoffTime(start, s.deviceCutoffMinutes), now, tenant.timezone) &&
          !cutoffPassed(autoCloseEnd(start, s.deviceCutoffMinutes), now, tenant.timezone)
        );
      })
      .map((section) => section.id);
  }

  /**
   * The cutoff for one section, in its own job transaction: under the punch lock, the register is
   * written when `closeDecision` says CLOSE (devices seen, every student on a device, at most half
   * missing, within the auto-close hour); held back, nothing is written (the today report says
   * why, live). Its absent SMS last. Returns whether a register was written.
   */
  async closeAtCutoff(sectionId: string): Promise<boolean> {
    const tenant = await this.settings.load();
    const s = tenant.settings;
    if (s.mode !== 'DAILY' || !s.deviceAutoMark) return false;
    if (await this.settings.nonWorkingDay(tenant.today, s)) return false;
    await this.deviceAttendance.lockPunches();
    const now = this.clock.now();
    const day = (await this.arrivals.sectionDays([sectionId], tenant.today, tenant)).get(sectionId);
    if (!day) return false;
    const decision = closeDecision({
      cutoffPassed: cutoffPassed(day.cutoff, now, tenant.timezone),
      autoCloseEnded: cutoffPassed(day.autoCloseEnd, now, tenant.timezone),
      devicesSeenRecently: await this.arrivals.devicesSeenRecently(now),
      enrolled: day.students.length,
      arrived: day.arrivals.size,
      notOnDevice: day.notOnDevice,
    });
    if (decision !== 'CLOSE') return false;
    const register = await this.write(tenant, sectionId, day, now);
    if (!register) return false;
    await this.absentSms.queue(tenant, tenant.today, register.absent);
    return true;
  }

  /**
   * An admin closes a held-back section's register from the device, after a confirm: the safety
   * rules of `closeDecision` and the auto-close hour do not apply, the cutoff does. Same register
   * as the cutoff writes (students no device has are ABSENT too), with the admin as the audit's
   * actor and still no taker.
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
      absent: statuses
        .filter(([id, status]) => status === 'ABSENT' && day.active.has(id))
        .map(([id]) => id),
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

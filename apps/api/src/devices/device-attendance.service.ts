import { Injectable } from '@nestjs/common';
import {
  DEVICE_SUBMISSION_ID,
  arrivalStatus,
  countsOnDay,
  dateToDb,
  firstCountingIn,
  localTimeOf,
  staffDay,
  type AttendanceStatus,
  type IsoDate,
  type PunchFlag,
} from '@jantrik/shared';
import { AbsentSmsService } from '../attendance/absent-sms.service.js';
import {
  AttendanceSettingsService,
  timeFromDb,
  timeToDb,
  type AttendanceTenant,
} from '../attendance/attendance-settings.service.js';
import { AuditService } from '../audit/audit.module.js';
import { Clock } from '../common/clock.js';
import { Db } from '../tenancy/db.service.js';

/**
 * Attendance rebuilt from device punches, one person-day at a time: a student's record on an
 * existing DEVICE register, and a staff member's day. Used by punch processing, punch reviews and
 * the cutoff, always with the institute's punch lock held (`lockPunches`). A record or day a
 * person set (MANUAL) is never changed.
 */
@Injectable()
export class DeviceAttendanceService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly settings: AttendanceSettingsService,
    private readonly audit: AuditService,
    private readonly absentSms: AbsentSmsService,
  ) {}

  /**
   * The institute's punch lock, held to the end of the transaction. Lock order: this lock, then
   * punch rows, then registers and staff days; never a device row after it (trusting an address
   * locks the device row first, then this).
   *
   * Every lock wait in the rest of the transaction is limited to 5 seconds: a query blocked on a
   * lock outlives the transaction's own time limit, so without it one stuck holder would stall the
   * devices worker for every institute. Past it the transaction fails; the next tick (or the
   * admin, for a review) tries again.
   */
  async lockPunches(): Promise<void> {
    const tx = this.db.tx;
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('device-punches:' || app_current_tenant_id()::text, 0))`;
  }

  /**
   * The student's record on the period-0 register of their current section for `date`, from the
   * punches that count: the first IN gives PRESENT or LATE, none gives ABSENT. Nothing without a
   * register or when the record is not DEVICE. A change bumps the version, keeps the register's
   * updater (a person who edited it stays named) and marks the device as its last change
   * (`DEVICE_SUBMISSION_ID`), is audited, and an ABSENT today queues the absent SMS (once per day,
   * by its dedupe key).
   */
  async recomputeStudentDay(
    studentId: string,
    date: IsoDate,
    tenant?: AttendanceTenant,
  ): Promise<void> {
    const tx = this.db.tx;
    const t = tenant ?? (await this.settings.load());
    const enrolment = await tx.enrolment.findFirst({
      where: { studentId, academicYear: { isCurrent: true } },
      select: { sectionId: true, section: { select: { shift: { select: { startTime: true } } } } },
    });
    if (!enrolment?.sectionId) return;
    // Locked as a submit locks it, so a teacher's change and this one apply one after the other.
    const [session] = await tx.$queryRaw<{ id: string; source: string }[]>`
      SELECT id::text, source::text FROM attendance_sessions
      WHERE section_id = ${enrolment.sectionId}::uuid AND date = ${dateToDb(date)}::date
        AND period_no = 0
      FOR UPDATE`;
    // Only a DEVICE register may name no updater (CHECK); a person's register has MANUAL records.
    if (!session || session.source !== 'DEVICE') return;
    const record = await tx.attendanceRecord.findUnique({
      where: { tenantId_sessionId_studentId: { tenantId: t.id, sessionId: session.id, studentId } },
      select: { id: true, status: true, source: true },
    });
    if (!record || record.source !== 'DEVICE') return;
    const person = await tx.devicePerson.findFirst({
      where: { studentId },
      select: { deviceUserId: true },
    });
    if (!person) return;

    const punches = await tx.devicePunch.findMany({
      where: { deviceUserId: person.deviceUserId, localDate: dateToDb(date), direction: 'IN' },
      select: { id: true, punchedAt: true, direction: true, flags: true, review: true },
    });
    const first = firstCountingIn(punches.map((p) => ({ ...p, flags: p.flags as PunchFlag[] })));
    const shift = enrolment.section?.shift;
    const status: AttendanceStatus = first
      ? arrivalStatus(
          localTimeOf(first.punchedAt, t.timezone),
          shift ? timeFromDb(shift.startTime) : t.settings.deviceDefaultStart,
          t.settings.deviceGraceMinutes,
        )
      : 'ABSENT';
    if (status === record.status) return;

    const now = this.clock.now();
    await tx.attendanceRecord.update({
      where: { id: record.id },
      data: { status, updatedAt: now },
    });
    await tx.attendanceSession.update({
      where: { id: session.id },
      data: {
        version: { increment: 1 },
        lastSubmissionId: DEVICE_SUBMISSION_ID,
        submittedAt: now,
        updatedAt: now,
      },
    });
    await this.audit.record({
      entity: 'attendance_session',
      entityId: session.id,
      action: 'UPDATE',
      oldValues: { [studentId]: record.status },
      newValues: { [studentId]: status, source: 'DEVICE' },
    });
    if (status === 'ABSENT') await this.absentSms.queue(t, date, [studentId]);
  }

  /**
   * The staff member's day from the punches of `date` that count, in any direction (`staffDay`),
   * judged by the office hours in the settings now, which the row keeps. No punch left: an
   * existing DEVICE day becomes ABSENT. A MANUAL day is never changed. Derived data, not audited.
   */
  async recomputeStaffDay(userId: string, date: IsoDate, tenant?: AttendanceTenant): Promise<void> {
    const tx = this.db.tx;
    const t = tenant ?? (await this.settings.load());
    const day = dateToDb(date);
    // Locked, so an admin's manual entry and this one apply one after the other.
    const [locked] = await tx.$queryRaw<{ id: string; source: string }[]>`
      SELECT id::text, source::text FROM staff_attendance_days
      WHERE user_id = ${userId}::uuid AND date = ${day}::date
      FOR UPDATE`;
    if (locked?.source === 'MANUAL') return;
    const row = locked
      ? await tx.staffAttendanceDay.findUniqueOrThrow({ where: { id: locked.id } })
      : null;
    const person = await tx.devicePerson.findFirst({
      where: { staffUserId: userId },
      select: { deviceUserId: true },
    });
    const punches = person
      ? await tx.devicePunch.findMany({
          where: { deviceUserId: person.deviceUserId, localDate: day },
          select: { punchedAt: true, flags: true, review: true },
        })
      : [];
    const counting = punches.filter((p) =>
      countsOnDay({ flags: p.flags as PunchFlag[], review: p.review }),
    );
    const now = this.clock.now();

    if (counting.length === 0) {
      if (!row || row.status === 'ABSENT') return;
      await tx.staffAttendanceDay.update({
        where: { id: row.id },
        data: {
          status: 'ABSENT',
          inAt: null,
          outAt: null,
          lateMinutes: 0,
          earlyMinutes: 0,
          version: { increment: 1 },
          updatedAt: now,
        },
      });
      return;
    }

    const s = t.settings;
    const computed = staffDay({
      punches: counting.map((p) => p.punchedAt),
      timeZone: t.timezone,
      officeStart: s.staffOfficeStart,
      officeEnd: s.staffOfficeEnd,
      lateGraceMin: s.staffLateGraceMinutes,
      earlyGraceMin: s.staffEarlyGraceMinutes,
    });
    const next = {
      status: 'PRESENT' as const,
      inAt: computed.inAt,
      outAt: computed.outAt,
      lateMinutes: computed.lateMinutes,
      earlyMinutes: computed.earlyMinutes,
      officeStart: timeToDb(s.staffOfficeStart),
      officeEnd: timeToDb(s.staffOfficeEnd),
    };
    if (row) {
      const same =
        row.status === next.status &&
        row.inAt?.getTime() === next.inAt.getTime() &&
        (row.outAt?.getTime() ?? null) === (next.outAt?.getTime() ?? null) &&
        row.lateMinutes === next.lateMinutes &&
        row.earlyMinutes === next.earlyMinutes &&
        timeFromDb(row.officeStart) === s.staffOfficeStart &&
        timeFromDb(row.officeEnd) === s.staffOfficeEnd;
      if (same) return;
      await tx.staffAttendanceDay.update({
        where: { id: row.id },
        data: { ...next, version: { increment: 1 }, updatedAt: now },
      });
      return;
    }
    // A manual day saved meanwhile keeps its place (the unique key; nothing is inserted then).
    await tx.staffAttendanceDay.createMany({
      data: [
        {
          tenantId: t.id,
          userId,
          date: day,
          source: 'DEVICE',
          ...next,
          createdAt: now,
          updatedAt: now,
        },
      ],
      skipDuplicates: true,
    });
  }
}

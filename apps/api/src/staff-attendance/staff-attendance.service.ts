import { Injectable } from '@nestjs/common';
import type { StaffAttendanceDay } from '@jantrik/db';
import {
  STAFF_ROLE_VALUES,
  countsOnDay,
  dateFromDb,
  dateToDb,
  localDateOf,
  localTimeOf,
  staffAttendanceTracked,
  staffDay,
  staffDayState,
  wallClockToUtc,
  type IsoDate,
  type PunchFlag,
  type StaffDayEntry,
  type StaffDayPunch,
  type StaffDayRecord,
  type StaffDayReport,
  type StaffRole,
  type StaffTrackedResult,
} from '@jantrik/shared';
import {
  AttendanceSettingsService,
  timeFromDb,
  timeToDb,
  type AttendanceTenant,
} from '../attendance/attendance-settings.service.js';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../common/request-context.js';
import { DeviceAttendanceService } from '../devices/device-attendance.service.js';
import { DevicePeopleRoster } from '../devices/device-people-roster.js';
import { staffNames, staffRef } from '../staff/staff.module.js';
import { Db } from '../tenancy/db.service.js';

/** Someone on the staff attendance screens. */
export interface StaffPerson {
  userId: string;
  name: string;
  nameBn: string | null;
  /** Active staff roles here; none for someone listed only for their stored days. */
  roles: StaffRole[];
  trackedSetting: boolean | null;
  /** `staffAttendanceTracked`: the same rule punch processing applies. */
  tracked: boolean;
  /** The day their staff profile was made, in the institute's timezone. */
  since: IsoDate;
}

type Names = Map<string, { name: string; nameBn: string | null }>;

function staffDayRecord(row: StaffAttendanceDay, names: Names): StaffDayRecord {
  return {
    status: row.status,
    inAt: row.inAt?.toISOString() ?? null,
    outAt: row.outAt?.toISOString() ?? null,
    lateMinutes: row.lateMinutes,
    earlyMinutes: row.earlyMinutes,
    source: row.source,
    reason: row.reason,
    version: row.version,
    updatedBy: staffRef(names, row.updatedById),
  };
}

/** A stored day as the audit log keeps it. */
const auditValues = (row: StaffAttendanceDay) => ({
  userId: row.userId,
  date: dateFromDb(row.date),
  status: row.status,
  inAt: row.inAt?.toISOString() ?? null,
  outAt: row.outAt?.toISOString() ?? null,
  lateMinutes: row.lateMinutes,
  earlyMinutes: row.earlyMinutes,
  officeStart: timeFromDb(row.officeStart),
  officeEnd: timeFromDb(row.officeEnd),
  source: row.source,
  reason: row.reason,
});

/**
 * Staff attendance for owners and admins: a day's list, a day set by hand and each person's
 * tracked switch. "Staff" are people with an active staff role and a staff profile; names come
 * from the profiles only. A day with no row is not stored as absent: its state is computed.
 */
@Injectable()
export class StaffAttendanceService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly settings: AttendanceSettingsService,
    private readonly roster: DevicePeopleRoster,
    private readonly deviceAttendance: DeviceAttendanceService,
  ) {}

  /**
   * Everyone with an active staff role and a profile, and the people in `alsoIds` (who have stored
   * days, so a profile), by name.
   */
  async people(timeZone: string, alsoIds: string[] = []): Promise<StaffPerson[]> {
    const roles = await this.roster.activeStaffRoles();
    const ids = [...new Set([...roles.keys(), ...alsoIds])];
    if (ids.length === 0) return [];
    const profiles = await this.db.tx.staffProfile.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, name: true, nameBn: true, attendanceTracked: true, createdAt: true },
    });
    return profiles
      .map((p): StaffPerson => {
        const mine = STAFF_ROLE_VALUES.filter((r) => roles.get(p.userId)?.has(r));
        return {
          userId: p.userId,
          name: p.name,
          nameBn: p.nameBn,
          roles: mine,
          trackedSetting: p.attendanceTracked,
          tracked: staffAttendanceTracked({
            tracked: p.attendanceTracked,
            activeStaffRoles: mine,
          }),
          since: localDateOf(p.createdAt, timeZone),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  }

  /** Whether today's office end (the settings now) has passed, by the clock. */
  officeEndPassedToday(t: AttendanceTenant): boolean {
    return localTimeOf(this.clock.now(), t.timezone) >= `${t.settings.staffOfficeEnd}:00`;
  }

  /** Everyone's day: the stored row, or what the day is without one; never a future date. */
  async day(date?: IsoDate): Promise<StaffDayReport> {
    const tx = this.db.tx;
    const t = await this.settings.load();
    const d = date ?? t.today;
    assertNotFuture(d, t);
    const s = t.settings;
    const nonWorkingDay = await this.settings.nonWorkingDay(d, s);
    const rows = await tx.staffAttendanceDay.findMany({ where: { date: dateToDb(d) } });
    const byUser = new Map(rows.map((r) => [r.userId, r]));
    const people = await this.people(t.timezone, [...byUser.keys()]);
    const names = await staffNames(tx, [
      ...new Set(rows.flatMap((r) => (r.updatedById ? [r.updatedById] : []))),
    ]);
    const punches = await this.countingPunches(
      d,
      people.map((p) => p.userId),
    );
    const officeEndPassedToday = this.officeEndPassedToday(t);
    return {
      today: t.today,
      date: d,
      nonWorkingDay,
      officeHours: {
        start: s.staffOfficeStart,
        end: s.staffOfficeEnd,
        lateGraceMinutes: s.staffLateGraceMinutes,
        earlyGraceMinutes: s.staffEarlyGraceMinutes,
      },
      people: people.map((p) => {
        const row = byUser.get(p.userId);
        return {
          userId: p.userId,
          name: p.name,
          nameBn: p.nameBn,
          roles: p.roles,
          tracked: p.tracked,
          trackedSetting: p.trackedSetting,
          day: row ? staffDayRecord(row, names) : null,
          state: row
            ? null
            : staffDayState({
                date: d,
                today: t.today,
                since: p.since,
                off: nonWorkingDay !== null,
                tracked: p.tracked,
                officeEndPassedToday,
              }),
          punches: punches.get(p.userId) ?? [],
        };
      }),
    };
  }

  /**
   * Set a day by hand: MANUAL from then on (punch processing never changes it), judged by the
   * office hours now, the caller as its updater, based on the version the admin saw. Audited.
   */
  async enter(userId: string, date: IsoDate, input: StaffDayEntry): Promise<StaffDayRecord> {
    const tx = this.db.tx;
    const t = await this.settings.load();
    assertNotFuture(date, t);
    await this.activeStaff(userId);
    const times = judge(date, input, t);
    const s = t.settings;

    // The punch lock first, as rebuilding this day from punches takes it: one after the other.
    await this.deviceAttendance.lockPunches();
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM staff_attendance_days
      WHERE user_id = ${userId}::uuid AND date = ${dateToDb(date)}::date
      FOR UPDATE`;
    const current = locked
      ? await tx.staffAttendanceDay.findUniqueOrThrow({ where: { id: locked.id } })
      : null;
    if ((current?.version ?? 0) !== input.baseVersion) {
      throw apiError(409, 'VERSION_CONFLICT', 'Someone changed this day meanwhile', {
        day: current ? await this.record(current) : null,
      });
    }
    const data = {
      status: input.status,
      ...times,
      officeStart: timeToDb(s.staffOfficeStart),
      officeEnd: timeToDb(s.staffOfficeEnd),
      source: 'MANUAL' as const,
      reason: input.reason,
      updatedById: this.context.requirePrincipal().userId,
    };
    const saved = current
      ? await tx.staffAttendanceDay.update({
          where: { id: current.id },
          data: { ...data, version: { increment: 1 } },
        })
      : await tx.staffAttendanceDay.create({
          data: { tenantId: t.id, userId, date: dateToDb(date), ...data },
        });
    await this.audit.record({
      entity: 'staff_attendance_day',
      entityId: saved.id,
      action: current ? 'UPDATE' : 'CREATE',
      oldValues: current ? auditValues(current) : undefined,
      newValues: auditValues(saved),
    });
    return this.record(saved);
  }

  /** A person's own switch: true, false, or null for the default rule. Audited. */
  async setTracked(userId: string, tracked: boolean | null): Promise<StaffTrackedResult> {
    const member = await this.activeStaff(userId);
    await this.db.tx.staffProfile.update({
      where: { id: member.profileId },
      data: { attendanceTracked: tracked },
    });
    await this.audit.record({
      entity: 'staff_profile',
      entityId: member.profileId,
      action: 'UPDATE',
      oldValues: { userId, attendanceTracked: member.attendanceTracked },
      newValues: { userId, attendanceTracked: tracked },
    });
    return {
      userId,
      tracked: staffAttendanceTracked({ tracked, activeStaffRoles: member.roles }),
      trackedSetting: tracked,
    };
  }

  /** The person's profile and active staff roles here; 422 NOT_STAFF without either. */
  private async activeStaff(userId: string) {
    const roles = (await this.roster.activeStaffRoles([userId])).get(userId);
    const profile = await this.db.tx.staffProfile.findFirst({
      where: { userId },
      select: { id: true, attendanceTracked: true },
    });
    if (!roles || !profile) {
      throw apiError(422, 'NOT_STAFF', 'This person is not active staff here');
    }
    return {
      profileId: profile.id,
      attendanceTracked: profile.attendanceTracked,
      roles: [...roles],
    };
  }

  private async record(row: StaffAttendanceDay): Promise<StaffDayRecord> {
    const names = await staffNames(this.db.tx, row.updatedById ? [row.updatedById] : []);
    return staffDayRecord(row, names);
  }

  /** Each person's punches of `date` that count (`countsOnDay`), under their device ID now. */
  private async countingPunches(
    date: IsoDate,
    userIds: string[],
  ): Promise<Map<string, StaffDayPunch[]>> {
    const tx = this.db.tx;
    const out = new Map<string, StaffDayPunch[]>();
    const mapped = await tx.devicePerson.findMany({
      where: { staffUserId: { in: userIds } },
      select: { deviceUserId: true, staffUserId: true },
    });
    if (mapped.length === 0) return out;
    const holder = new Map(mapped.map((m) => [m.deviceUserId, m.staffUserId!]));
    const rows = await tx.devicePunch.findMany({
      where: { deviceUserId: { in: [...holder.keys()] }, localDate: dateToDb(date) },
      orderBy: [{ punchedAt: 'asc' }, { id: 'asc' }],
      select: {
        deviceUserId: true,
        punchedAt: true,
        flags: true,
        review: true,
        device: { select: { name: true } },
      },
    });
    for (const r of rows) {
      if (!countsOnDay({ flags: r.flags as PunchFlag[], review: r.review })) continue;
      const userId = holder.get(r.deviceUserId)!;
      const list = out.get(userId) ?? [];
      list.push({ punchedAt: r.punchedAt.toISOString(), deviceName: r.device.name });
      out.set(userId, list);
    }
    return out;
  }
}

function assertNotFuture(date: IsoDate, t: AttendanceTenant): void {
  if (date > t.today) {
    throw apiError(422, 'FUTURE_DATE', 'Staff attendance cannot be set for a future date', {
      today: t.today,
    });
  }
}

/**
 * A PRESENT day's instants (typed local times in the institute's timezone) and late and early
 * minutes by the office hours now (`staffDay`); other days keep no times.
 */
function judge(date: IsoDate, input: StaffDayEntry, t: AttendanceTenant) {
  if (input.status !== 'PRESENT') {
    return { inAt: null, outAt: null, lateMinutes: 0, earlyMinutes: 0 };
  }
  if (!input.inAt) throw apiError(422, 'IN_TIME_REQUIRED', 'A present day needs an in time');
  const instant = (hhmm: string) => wallClockToUtc(`${date} ${hhmm}:00`, t.timezone);
  const inAt = instant(input.inAt);
  const outAt = input.outAt ? instant(input.outAt) : null;
  if (outAt && outAt < inAt) {
    throw apiError(422, 'OUT_BEFORE_IN', 'The out time is before the in time');
  }
  const s = t.settings;
  const judged = staffDay({
    punches: outAt ? [inAt, outAt] : [inAt],
    timeZone: t.timezone,
    officeStart: s.staffOfficeStart,
    officeEnd: s.staffOfficeEnd,
    lateGraceMin: s.staffLateGraceMinutes,
    earlyGraceMin: s.staffEarlyGraceMinutes,
    // A typed out time stands however soon after the in time it is (no 30-minute rule); with
    // the in time alone there is no out.
    minGapMin: outAt ? 0 : undefined,
  });
  return { inAt, outAt, lateMinutes: judged.lateMinutes, earlyMinutes: judged.earlyMinutes };
}

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import {
  addDays,
  dateFromDb,
  dateToDb,
  entrySmsText,
  exitSmsText,
  movementOf,
  punchOutcome,
  sendsSms,
  staffAttendanceTracked,
  type DayPunch,
  type IsoDate,
  type PunchFlag,
  type PunchOutcome,
  type StaffRole,
} from '@jantrik/shared';
import { AbsentSmsService, type GuardianContact } from '../attendance/absent-sms.service.js';
import {
  AttendanceSettingsService,
  type AttendanceTenant,
} from '../attendance/attendance-settings.service.js';
import { Clock } from '../common/clock.js';
import { TenantSmsService } from '../sms/tenant-sms.service.js';
import { Db } from '../tenancy/db.service.js';
import { DeviceAttendanceService } from './device-attendance.service.js';
import { DevicePeopleRoster } from './device-people-roster.js';

/** Staff days are rebuilt for punches up to this many days old (older ones are STALE). */
const STAFF_DAYS_BACK = 7;

/** Entry and exit SMS stop at this share of the daily cap, leaving the rest for absent alerts. */
const MOVEMENT_SMS_CAP_SHARE = 0.9;

const PUNCH_SELECT = {
  id: true,
  deviceUserId: true,
  punchedAt: true,
  receivedAt: true,
  localDate: true,
  direction: true,
  flags: true,
  review: true,
} satisfies Prisma.DevicePunchSelect;
type PunchRow = Prisma.DevicePunchGetPayload<{ select: typeof PUNCH_SELECT }>;

interface Punch extends DayPunch {
  deviceUserId: string;
  receivedAt: Date;
  localDate: IsoDate;
}

const toPunch = (r: PunchRow): Punch => ({
  ...r,
  flags: r.flags as PunchFlag[],
  localDate: dateFromDb(r.localDate),
});

/** Who a device ID belongs to now, and whether their punches apply (`punchOutcome`). */
interface Person {
  kind: 'STUDENT' | 'STAFF';
  /** The student id, or the staff member's user id. */
  id: string;
  active: boolean;
}

/**
 * Turns an institute's raw punches into attendance, inside its RLS context (a job, or a review's
 * request): each punch's outcome, the guardian entry and exit SMS, the student's record on an
 * existing DEVICE register (today) and the staff day. Registers are written at the cutoff, not
 * here.
 */
@Injectable()
export class PunchProcessingService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly settings: AttendanceSettingsService,
    private readonly sms: TenantSmsService,
    private readonly absentSms: AbsentSmsService,
    private readonly deviceAttendance: DeviceAttendanceService,
    private readonly roster: DevicePeopleRoster,
  ) {}

  /** An entry or exit SMS stays wanted once queued: the punch happened. */
  onModuleInit(): void {
    this.sms.registerRelevanceCheck('ATTENDANCE_ENTRY', () => Promise.resolve(true));
    this.sms.registerRelevanceCheck('ATTENDANCE_EXIT', () => Promise.resolve(true));
  }

  /**
   * Up to `limit` unprocessed punches, oldest punch time first, in one transaction under the
   * institute's punch lock. Returns how many were processed (fewer than `limit`: none are left).
   */
  async processBatch(limit: number): Promise<number> {
    const tx = this.db.tx;
    await this.deviceAttendance.lockPunches();
    const punches = (
      await tx.devicePunch.findMany({
        where: { processedAt: null },
        orderBy: [{ punchedAt: 'asc' }, { id: 'asc' }],
        take: limit,
        select: PUNCH_SELECT,
      })
    ).map(toPunch);
    if (punches.length === 0) return 0;

    const tenant = await this.settings.load();
    const people = await this.people([...new Set(punches.map((p) => p.deviceUserId))]);
    const byOutcome = new Map<PunchOutcome, string[]>();
    const applied: { punch: Punch; person: Person }[] = [];
    for (const punch of punches) {
      const person = people.get(punch.deviceUserId) ?? null;
      const outcome = punchOutcome(punch, person);
      const ids = byOutcome.get(outcome) ?? [];
      ids.push(punch.id);
      byOutcome.set(outcome, ids);
      if (outcome === 'APPLIED') applied.push({ punch, person: person! });
    }
    // Lock order: the punch lock, punch rows, registers and staff days, then the SMS lock (a
    // submit locks its register before the SMS lock too).
    const now = this.clock.now();
    for (const [outcome, ids] of byOutcome) {
      await tx.devicePunch.updateMany({
        where: { id: { in: ids } },
        data: { processedAt: now, outcome },
      });
    }
    const days = new Map<string, { person: Person; date: IsoDate }>();
    for (const { punch, person } of applied) {
      days.set(`${person.kind}:${person.id}:${punch.localDate}`, { person, date: punch.localDate });
    }
    for (const { person, date } of days.values()) await this.applyDay(tenant, person, date);
    await this.movementSms(
      tenant,
      applied.filter((a) => a.person.kind === 'STUDENT'),
    );
    return punches.length;
  }

  /**
   * After a review changed whether a punch counts, inside the review's transaction (punch lock and
   * punch row held): its outcome by the same rules, and that person's day rebuilt. Never an entry
   * or exit SMS. A punch not processed yet is left to processing, which sees the review.
   */
  async reviewed(punchId: string): Promise<void> {
    const tx = this.db.tx;
    const row = await tx.devicePunch.findUnique({
      where: { id: punchId },
      select: { ...PUNCH_SELECT, processedAt: true, outcome: true },
    });
    if (!row?.processedAt) return;
    const punch = toPunch(row);
    const person = (await this.people([punch.deviceUserId])).get(punch.deviceUserId) ?? null;
    const outcome = punchOutcome(punch, person);
    if (outcome !== row.outcome) {
      await tx.devicePunch.update({ where: { id: punchId }, data: { outcome } });
    }
    if (outcome === 'STALE' || !person?.active) return;
    await this.applyDay(await this.settings.load(), person, punch.localDate);
  }

  /**
   * A person-day's attendance from its punches: a student's record on an existing register only in
   * DAILY mode with auto-mark, and only today; a staff day up to 7 days back.
   */
  private async applyDay(tenant: AttendanceTenant, person: Person, date: IsoDate): Promise<void> {
    if (person.kind === 'STUDENT') {
      const s = tenant.settings;
      if (s.mode !== 'DAILY' || !s.deviceAutoMark || date !== tenant.today) return;
      await this.deviceAttendance.recomputeStudentDay(person.id, date, tenant);
      return;
    }
    if (date < addDays(tenant.today, -STAFF_DAYS_BACK) || date > tenant.today) return;
    await this.deviceAttendance.recomputeStaffDay(person.id, date, tenant);
  }

  /**
   * Entry SMS for a student's first IN of the day, exit SMS for the first OUT after it: only for
   * real-time unflagged punches (`sendsSms`), on working days, when turned on, to the primary
   * guardian, once per student per day and direction, and never over 90 % of the daily cap (in
   * any mode: they need no register).
   */
  private async movementSms(
    tenant: AttendanceTenant,
    applied: { punch: Punch; person: Person }[],
  ): Promise<void> {
    const s = tenant.settings;
    if (!s.entrySmsEnabled && !s.exitSmsEnabled) return;
    const candidates = applied.filter((a) => sendsSms(a.punch));
    if (candidates.length === 0) return;

    // Each student's punches of those days, processed or not.
    const dates = [...new Set(candidates.map((a) => a.punch.localDate))].sort();
    const rows = await this.db.tx.devicePunch.findMany({
      where: {
        deviceUserId: { in: [...new Set(candidates.map((a) => a.punch.deviceUserId))] },
        localDate: { in: dates.map(dateToDb) },
      },
      select: PUNCH_SELECT,
    });
    const days = new Map<string, Punch[]>();
    for (const p of rows.map(toPunch)) {
      const key = `${p.deviceUserId}|${p.localDate}`;
      const day = days.get(key) ?? [];
      day.push(p);
      days.set(key, day);
    }
    const offDays = await this.settings.nonWorkingDays(dates[0]!, dates.at(-1)!, s);
    let contacts: Map<string, GuardianContact> | null = null;
    let cap: number | null = null;

    for (const { punch, person } of candidates) {
      const movement = movementOf(
        punch,
        days.get(`${punch.deviceUserId}|${punch.localDate}`) ?? [],
      );
      if (movement === null || offDays[punch.localDate]) continue;
      const entry = movement === 'ENTRY';
      if (entry ? !s.entrySmsEnabled : !s.exitSmsEnabled) continue;
      contacts ??= await this.absentSms.contacts([...new Set(candidates.map((a) => a.person.id))]);
      const contact = contacts.get(person.id);
      if (!contact?.phone) continue;
      cap ??= Math.floor((await this.settings.effectiveDailySmsCap(s)) * MOVEMENT_SMS_CAP_SHARE);
      const text = { student: contact.student, at: punch.punchedAt, institute: tenant.name };
      await this.sms.queue({
        purpose: entry ? 'ATTENDANCE_ENTRY' : 'ATTENDANCE_EXIT',
        phone: contact.phone,
        body: entry ? entrySmsText(text) : exitSmsText(text),
        localDate: punch.localDate,
        dedupeKey: `${entry ? 'entry' : 'exit'}:${person.id}:${punch.localDate}`,
        relatedEntity: 'student',
        relatedId: person.id,
        delayMs: 0,
        dailyCap: cap,
        overCap: 'SKIP',
      });
    }
  }

  /**
   * Who each device ID belongs to now. A student applies when not deleted, ACTIVE and enrolled
   * this year; a staff member when they have an active staff role and their attendance is kept.
   */
  private async people(deviceUserIds: string[]): Promise<Map<string, Person>> {
    const rows = await this.db.tx.devicePerson.findMany({
      where: { deviceUserId: { in: deviceUserIds } },
      select: {
        deviceUserId: true,
        staffUserId: true,
        student: {
          select: {
            id: true,
            status: true,
            deletedAt: true,
            enrolments: {
              where: { academicYear: { isCurrent: true } },
              select: { id: true },
              take: 1,
            },
          },
        },
        staffProfile: { select: { attendanceTracked: true } },
      },
    });
    const staffIds = rows.flatMap((r) => (r.staffUserId ? [r.staffUserId] : []));
    const roles =
      staffIds.length > 0
        ? await this.roster.activeStaffRoles(staffIds)
        : new Map<string, Set<StaffRole>>();
    const out = new Map<string, Person>();
    for (const r of rows) {
      if (r.student) {
        const st = r.student;
        out.set(r.deviceUserId, {
          kind: 'STUDENT',
          id: st.id,
          active: st.deletedAt === null && st.status === 'ACTIVE' && st.enrolments.length > 0,
        });
      } else if (r.staffUserId) {
        out.set(r.deviceUserId, {
          kind: 'STAFF',
          id: r.staffUserId,
          active: staffAttendanceTracked({
            tracked: r.staffProfile?.attendanceTracked ?? null,
            activeStaffRoles: [...(roles.get(r.staffUserId) ?? [])],
          }),
        });
      }
    }
    return out;
  }
}

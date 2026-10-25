import { Injectable } from '@nestjs/common';
import {
  DEVICES_SEEN_WINDOW_MS,
  arrivalStatus,
  cutoffTime,
  dateToDb,
  firstCountingIn,
  localTimeOf,
  type IsoDate,
  type PunchFlag,
} from '@jantrik/shared';
import { Db } from '../tenancy/db.service.js';
import { timeFromDb, type AttendanceTenant } from './attendance-settings.service.js';

/** A student's arrival: the first IN punch that counts, PRESENT or LATE by the shift start. */
export interface Arrival {
  at: Date;
  status: 'PRESENT' | 'LATE';
}

/** What the device punches say about one section's day. */
export interface SectionDeviceDay {
  /** The section's shift start, or the institute's "school starts at" (HH:MM). */
  start: string;
  /** Start + cutoff minutes (HH:MM:SS). */
  cutoff: string;
  /** The register's roster: the students a submit expects, by roll. */
  students: string[];
  /** Those of them with an arrival. */
  arrivals: Map<string, Arrival>;
}

/**
 * Students' arrivals from device punches, for the take screen, the today report, the cutoff and
 * closing a register from the device. Read only; the cutoff holds the institute's punch lock
 * around it.
 */
@Injectable()
export class DeviceArrivalsService {
  constructor(private readonly db: Db) {}

  /** For sections of the current year: their shift's cutoff, roster and arrivals on `date`. */
  async sectionDays(
    sectionIds: string[],
    date: IsoDate,
    tenant: AttendanceTenant,
  ): Promise<Map<string, SectionDeviceDay>> {
    if (sectionIds.length === 0) return new Map();
    const tx = this.db.tx;
    const sections = await tx.section.findMany({
      where: { id: { in: sectionIds } },
      select: { id: true, academicYearId: true, shift: { select: { startTime: true } } },
    });
    // The same students `AttendanceService.roster` returns for each section, in its order.
    const enrolments = await tx.enrolment.findMany({
      where: {
        OR: sections.map((s) => ({ sectionId: s.id, academicYearId: s.academicYearId })),
        student: { deletedAt: null },
      },
      orderBy: [{ roll: { sort: 'asc', nulls: 'last' } }, { student: { studentCode: 'asc' } }],
      select: { sectionId: true, studentId: true },
    });
    const days = new Map<string, SectionDeviceDay>();
    for (const s of sections) {
      const start = startOf(s.shift, tenant);
      days.set(s.id, {
        start,
        cutoff: cutoffTime(start, tenant.settings.deviceCutoffMinutes),
        students: [],
        arrivals: new Map(),
      });
    }
    for (const e of enrolments) if (e.sectionId) days.get(e.sectionId)?.students.push(e.studentId);
    const starts = new Map<string, string>();
    for (const day of days.values()) for (const id of day.students) starts.set(id, day.start);
    const arrivals = await this.arrivals(starts, date, tenant);
    for (const day of days.values()) {
      for (const id of day.students) {
        const arrival = arrivals.get(id);
        if (arrival) day.arrivals.set(id, arrival);
      }
    }
    return days;
  }

  /** The section's shift start, or the institute's "school starts at" (HH:MM). */
  async sectionStart(sectionId: string, tenant: AttendanceTenant): Promise<string> {
    const section = await this.db.tx.section.findUnique({
      where: { id: sectionId },
      select: { shift: { select: { startTime: true } } },
    });
    return startOf(section?.shift ?? null, tenant);
  }

  /**
   * Each student's first IN punch of `date` that counts (not rejected, not a held BURST, not
   * STALE), under their device ID now, judged by their start (student id → HH:MM) and the grace.
   * Students without one are left out.
   */
  async arrivals(
    starts: Map<string, string>,
    date: IsoDate,
    tenant: AttendanceTenant,
  ): Promise<Map<string, Arrival>> {
    const out = new Map<string, Arrival>();
    if (starts.size === 0) return out;
    const tx = this.db.tx;
    const people = await tx.devicePerson.findMany({
      where: { studentId: { in: [...starts.keys()] } },
      select: { deviceUserId: true, studentId: true },
    });
    if (people.length === 0) return out;
    const punches = await tx.devicePunch.findMany({
      where: {
        deviceUserId: { in: people.map((p) => p.deviceUserId) },
        localDate: dateToDb(date),
        direction: 'IN',
      },
      select: {
        id: true,
        deviceUserId: true,
        punchedAt: true,
        direction: true,
        flags: true,
        review: true,
      },
    });
    const byPerson = new Map<string, typeof punches>();
    for (const p of punches) {
      const list = byPerson.get(p.deviceUserId) ?? [];
      list.push(p);
      byPerson.set(p.deviceUserId, list);
    }
    for (const person of people) {
      const first = firstCountingIn(
        (byPerson.get(person.deviceUserId) ?? []).map((p) => ({
          ...p,
          flags: p.flags as PunchFlag[],
        })),
      );
      if (!first || !person.studentId) continue;
      out.set(person.studentId, {
        at: first.punchedAt,
        status: arrivalStatus(
          localTimeOf(first.punchedAt, tenant.timezone),
          starts.get(person.studentId)!,
          tenant.settings.deviceGraceMinutes,
        ),
      });
    }
    return out;
  }

  /** Whether an active device called in within the last 15 minutes (no lock is taken). */
  async devicesSeenRecently(now: Date): Promise<boolean> {
    const seen = await this.db.tx.attendanceDevice.findFirst({
      where: {
        isActive: true,
        lastSeenAt: { gte: new Date(now.getTime() - DEVICES_SEEN_WINDOW_MS) },
      },
      select: { id: true },
    });
    return seen !== null;
  }
}

/** A section's start: its shift's, or the institute's "school starts at" (HH:MM). */
export const startOf = (shift: { startTime: Date } | null, tenant: AttendanceTenant): string =>
  shift ? timeFromDb(shift.startTime) : tenant.settings.deviceDefaultStart;

/** Whether the local time of `now` is at or past a cutoff (HH:MM:SS). */
export const cutoffPassed = (cutoff: string, now: Date, timeZone: string): boolean =>
  localTimeOf(now, timeZone) >= cutoff;

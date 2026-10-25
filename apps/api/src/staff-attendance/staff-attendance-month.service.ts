import { Injectable } from '@nestjs/common';
import {
  STAFF_CELL_CODES,
  dateFromDb,
  dateToDb,
  localTimeOf,
  monthDates,
  staffMonth,
  toCsv,
  type StaffCell,
  type StaffMonthCsvQuery,
  type StaffMonthDay,
  type StaffMonthDetail,
  type StaffMonthPerson,
  type StaffMonthReport,
} from '@jantrik/shared';
import { AttendanceSettingsService } from '../attendance/attendance-settings.service.js';
import { Db } from '../tenancy/db.service.js';
import { StaffAttendanceService } from './staff-attendance.service.js';

const CSV_LABELS = {
  bn: {
    name: 'নাম',
    present: 'উপস্থিত',
    late: 'দেরি',
    early: 'আগে প্রস্থান',
    absent: 'অনুপস্থিত',
    leave: 'ছুটি',
    lateMinutes: 'দেরি (মিনিট)',
    earlyMinutes: 'আগে প্রস্থান (মিনিট)',
    date: 'তারিখ',
    status: 'অবস্থা',
    in: 'প্রবেশ',
    out: 'প্রস্থান',
    source: 'উৎস',
    reason: 'কারণ',
    statuses: { PRESENT: 'উপস্থিত', ABSENT: 'অনুপস্থিত', LEAVE: 'ছুটি' },
    sources: { DEVICE: 'ডিভাইস', MANUAL: 'হাতে' },
  },
  en: {
    name: 'Name',
    present: 'Present',
    late: 'Late',
    early: 'Early leave',
    absent: 'Absent',
    leave: 'Leave',
    lateMinutes: 'Late minutes',
    earlyMinutes: 'Early leave minutes',
    date: 'Date',
    status: 'Status',
    in: 'In',
    out: 'Out',
    source: 'Source',
    reason: 'Reason',
    statuses: { PRESENT: 'Present', ABSENT: 'Absent', LEAVE: 'Leave' },
    sources: { DEVICE: 'Device', MANUAL: 'Manual' },
  },
} as const;

/**
 * The staff month: people × days by `staffMonth` (the same rules as the day view), each stored
 * day for the side panel, and the two CSVs built from that same report. Late and early minutes
 * are the stored ones, judged by the office hours of their day, so new hours never change a past
 * month.
 */
@Injectable()
export class StaffAttendanceMonthService {
  constructor(
    private readonly db: Db,
    private readonly settings: AttendanceSettingsService,
    private readonly staff: StaffAttendanceService,
  ) {}

  async month(month: string): Promise<StaffMonthReport> {
    return (await this.build(month)).report;
  }

  /**
   * UTF-8 with a BOM, CRLF line ends and ASCII digits, like the register CSV. `grid`: a row per
   * person with each day's code and the totals; `days`: a row per stored day with its local times.
   */
  async csv(query: StaffMonthCsvQuery): Promise<{ filename: string; csv: string }> {
    const { report, timeZone } = await this.build(query.month);
    const labels = CSV_LABELS[query.locale];
    const nameOf = (p: StaffMonthPerson) => (query.locale === 'bn' ? (p.nameBn ?? p.name) : p.name);
    let rows: (string | number | null)[][];
    if (query.kind === 'grid') {
      const codes: Partial<Record<StaffCell, string>> = STAFF_CELL_CODES[query.locale];
      rows = [
        [
          labels.name,
          ...report.days.map((d) => String(Number(d.date.slice(8)))),
          labels.present,
          labels.late,
          labels.early,
          labels.absent,
          labels.leave,
          labels.lateMinutes,
          labels.earlyMinutes,
        ],
        ...report.people.map((p) => [
          nameOf(p),
          // OFF and NONE days are empty.
          ...p.cells.map((c) => codes[c] ?? ''),
          p.totals.present,
          p.totals.late,
          p.totals.early,
          p.totals.absent,
          p.totals.leave,
          p.totals.lateMinutes,
          p.totals.earlyMinutes,
        ]),
      ];
    } else {
      const time = (at: string | null) =>
        at ? localTimeOf(new Date(at), timeZone).slice(0, 5) : '';
      rows = [
        [
          labels.date,
          labels.name,
          labels.status,
          labels.in,
          labels.out,
          labels.lateMinutes,
          labels.earlyMinutes,
          labels.source,
          labels.reason,
        ],
        ...report.people.flatMap((p) =>
          p.details.map((d) => [
            d.date,
            nameOf(p),
            labels.statuses[d.status],
            time(d.inAt),
            time(d.outAt),
            d.lateMinutes,
            d.earlyMinutes,
            labels.sources[d.source],
            d.reason,
          ]),
        ),
      ];
    }
    // ASCII only: the browser download names the file itself; this is the fallback.
    const suffix = query.kind === 'days' ? '-days' : '';
    return { filename: `staff-attendance-${query.month}${suffix}.csv`, csv: toCsv(rows) };
  }

  /** Tracked staff, and anyone with a stored day in the month (people no longer staff too). */
  private async build(month: string): Promise<{ report: StaffMonthReport; timeZone: string }> {
    const t = await this.settings.load();
    const dates = monthDates(month);
    const from = dates[0]!;
    const to = dates.at(-1)!;
    const nonWorking = await this.settings.nonWorkingDays(from, to, t.settings);
    const rows = await this.db.tx.staffAttendanceDay.findMany({
      where: { date: { gte: dateToDb(from), lte: dateToDb(to) } },
      orderBy: { date: 'asc' },
      select: {
        userId: true,
        date: true,
        status: true,
        inAt: true,
        outAt: true,
        lateMinutes: true,
        earlyMinutes: true,
        source: true,
        reason: true,
      },
    });
    const details = new Map<string, StaffMonthDetail[]>();
    for (const r of rows) {
      const list = details.get(r.userId) ?? [];
      list.push({
        date: dateFromDb(r.date),
        status: r.status,
        inAt: r.inAt?.toISOString() ?? null,
        outAt: r.outAt?.toISOString() ?? null,
        lateMinutes: r.lateMinutes,
        earlyMinutes: r.earlyMinutes,
        source: r.source,
        reason: r.reason,
      });
      details.set(r.userId, list);
    }
    const people = (await this.staff.people(t.timezone, [...details.keys()])).filter(
      (p) => p.tracked || details.has(p.userId),
    );
    const days = dates.map((date): StaffMonthDay => {
      const off = nonWorking[date];
      if (off?.reason === 'HOLIDAY') {
        return { date, off: true, holidayName: { bn: off.nameBn, en: off.nameEn } };
      }
      return { date, off: off !== undefined };
    });
    const grid = staffMonth({
      month,
      days: days.map((d) => ({ date: d.date, off: d.off })),
      today: t.today,
      people: people.map((p) => ({ key: p.userId, since: p.since, tracked: p.tracked })),
      rows: [...details].flatMap(([key, list]) =>
        list.map((d) => ({
          key,
          date: d.date,
          status: d.status,
          lateMinutes: d.lateMinutes,
          earlyMinutes: d.earlyMinutes,
        })),
      ),
      officeEndPassedToday: this.staff.officeEndPassedToday(t),
    });
    return {
      timeZone: t.timezone,
      report: {
        month,
        days,
        people: people.map((p, i) => ({
          userId: p.userId,
          name: p.name,
          nameBn: p.nameBn,
          roles: p.roles,
          cells: grid[i]!.cells,
          totals: grid[i]!.totals,
          details: details.get(p.userId) ?? [],
        })),
      },
    };
  }
}

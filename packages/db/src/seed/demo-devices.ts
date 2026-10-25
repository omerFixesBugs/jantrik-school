import {
  addDays,
  dateFromDb,
  dateToDb,
  defaultStudentDeviceId,
  isoWeekday,
  isStaffRole,
  nextStaffDeviceId,
  normalizeBdPhone,
  punchDirection,
  staffAttendanceTracked,
  staffDay,
  todayIn,
  wallClockToUtc,
  type IsoDate,
} from '@jantrik/shared';
import type { Prisma, Role } from '../generated/prisma/client.js';
import type { TenantTx } from '../tenancy/context.js';
import { unit } from './past-attendance.js';

/** Calendar days before the seed date with staff attendance (today is left to punch live). */
export const STAFF_HISTORY_DAYS = 30;

const GATE = { serialNo: 'DEMO00000001', name: 'প্রধান ফটক', gate: 'প্রধান ফটক' };
const STAFF_ROOM = { serialNo: 'DEMO00000002', name: 'শিক্ষকদের কক্ষ', gate: 'শিক্ষকদের কক্ষ' };

const LEAVE_REASON = 'অসুস্থতার ছুটি';

const phone = (raw: string) => normalizeBdPhone(raw)!;

/**
 * Person-days that are not a plain in and out, counted back in working days from the seed date
 * (1 = the last working day before it).
 */
const SPECIAL_DAYS: { phone: string; back: number; day: 'LEAVE' | 'ABSENT' | { out: string } }[] = [
  // Sharmin (teacher): a sick day an admin entered by hand.
  { phone: phone('01911000999'), back: 8, day: 'LEAVE' },
  // Shahana: no punch at all.
  { phone: phone('01711000004'), back: 4, day: 'ABSENT' },
  // Nasrin and Rafiqul each leave early once.
  { phone: phone('01711000002'), back: 3, day: { out: '15:41:07' } },
  { phone: phone('01711000003'), back: 12, day: { out: '15:34:52' } },
];

/** The working days of the `days` calendar days before `today`, oldest first. */
export function workingDaysBefore(
  today: IsoDate,
  days: number,
  isOff: (date: IsoDate) => boolean,
): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = addDays(today, -days); d < today; d = addDays(d, 1)) {
    if (!isOff(d)) out.push(d);
  }
  return out;
}

/**
 * Deterministic 0–1 from a key: `unit` (FNV-1a) finished with murmur3's fmix32. FNV-1a alone
 * spreads keys that differ only in their last characters (the date) far too unevenly.
 */
function spread(key: string): number {
  let h = unit(key) * 0x1_0000_0000;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}

const clock = (seconds: number): string =>
  [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
const at = (h: number, m: number) => h * 3600 + m * 60;

/** In at 07:40–08:09, or about one day in eight late (past the 10-minute grace) at 08:11–08:25. */
function inTime(pin: string, date: IsoDate): string {
  const r = spread(`in:${pin}:${date}`);
  const late = spread(`late:${pin}:${date}`) < 0.12;
  return clock(late ? at(8, 11) + Math.floor(r * 15 * 60) : at(7, 40) + Math.floor(r * 30 * 60));
}

/** Out at 15:51–16:30 (the early leaves are in SPECIAL_DAYS). */
function outTime(pin: string, date: IsoDate): string {
  return clock(at(15, 51) + Math.floor(spread(`out:${pin}:${date}`) * 40 * 60));
}

export interface OfficeHours {
  start: string;
  end: string;
  lateGraceMin: number;
  earlyGraceMin: number;
}

export interface PlannedPunch {
  deviceUserId: string;
  date: IsoDate;
  /** The device's wall clock, `YYYY-MM-DD HH:MM:SS` (no zone). */
  deviceTime: string;
  punchedAt: Date;
  receivedAt: Date;
  /** The BOTH device's state key: 0 check-in, 1 check-out. */
  state: 0 | 1;
}

export interface PlannedDay {
  userId: string;
  date: IsoDate;
  status: 'PRESENT' | 'LEAVE';
  inAt: Date | null;
  outAt: Date | null;
  lateMinutes: number;
  earlyMinutes: number;
  source: 'DEVICE' | 'MANUAL';
  reason: string | null;
}

/**
 * Staff attendance as the devices would have recorded it: an in and an out punch per working day,
 * each day as punch processing computes it (`staffDay`), and the SPECIAL_DAYS. Deterministic:
 * the times come from the device ID and the date.
 */
export function planStaffAttendance(input: {
  /** Working days, oldest first. */
  dates: IsoDate[];
  people: { userId: string; phone: string; deviceUserId: string }[];
  timeZone: string;
  office: OfficeHours;
}): { punches: PlannedPunch[]; days: PlannedDay[] } {
  const { dates, timeZone, office } = input;
  const special = new Map(
    SPECIAL_DAYS.flatMap((s) => {
      const date = dates.at(-s.back);
      return date ? [[`${s.phone}|${date}`, s.day] as const] : [];
    }),
  );
  const punches: PlannedPunch[] = [];
  const days: PlannedDay[] = [];
  for (const person of input.people) {
    const pin = person.deviceUserId;
    for (const date of dates) {
      const kind = special.get(`${person.phone}|${date}`);
      if (kind === 'ABSENT') continue;
      if (kind === 'LEAVE') {
        days.push({
          userId: person.userId,
          date,
          status: 'LEAVE',
          inAt: null,
          outAt: null,
          lateMinutes: 0,
          earlyMinutes: 0,
          source: 'MANUAL',
          reason: LEAVE_REASON,
        });
        continue;
      }
      const mine = [inTime(pin, date), kind?.out ?? outTime(pin, date)].map(
        (time, state): PlannedPunch => {
          const deviceTime = `${date} ${time}`;
          const punchedAt = wallClockToUtc(deviceTime, timeZone);
          // The device is online: each punch arrives within seconds.
          const delay = 2 + Math.floor(spread(`sent:${pin}:${deviceTime}`) * 20);
          const receivedAt = new Date(punchedAt.getTime() + delay * 1000);
          return {
            deviceUserId: pin,
            date,
            deviceTime,
            punchedAt,
            receivedAt,
            state: state as 0 | 1,
          };
        },
      );
      punches.push(...mine);
      const day = staffDay({
        punches: mine.map((p) => p.punchedAt),
        timeZone,
        officeStart: office.start,
        officeEnd: office.end,
        lateGraceMin: office.lateGraceMin,
        earlyGraceMin: office.earlyGraceMin,
      });
      days.push({
        userId: person.userId,
        date,
        status: 'PRESENT',
        ...day,
        source: 'DEVICE',
        reason: null,
      });
    }
  }
  return { punches, days };
}

export interface DeviceSeedContext {
  tenantId: string;
  /** Staff in the order the seed added them (their profiles' order), with their roles here. */
  staff: { userId: string; phone: string; roles: Role[] }[];
}

const timeFromDb = (d: Date) => d.toISOString().slice(11, 16);

/**
 * Shapla (step 11): two devices, a device ID for every current student (from the student code)
 * and staff member (from the staff start, skipping students' numbers), and staff attendance for
 * the working days of the month before the seed date (`planStaffAttendance`). No student punches
 * and no device registers: auto-mark and the entry/exit SMS stay off. Returns the punches for the
 * caller to insert as the owner role: the app role never inserts punches (only the receiver does).
 */
export async function seedDemoDevices(
  tx: TenantTx,
  ctx: DeviceSeedContext,
): Promise<Prisma.DevicePunchCreateManyInput[]> {
  const { tenantId } = ctx;
  const admin = ctx.staff.find((m) => m.roles.includes('ADMIN'));
  if (!admin) throw new Error('Demo seed: the devices need an admin');
  const by = { createdById: admin.userId, updatedById: admin.userId };
  const { timezone } = await tx.tenant.findFirstOrThrow({ select: { timezone: true } });
  const settings = await tx.attendanceSettings.findFirstOrThrow();
  const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });

  // Registered now, so the first address that connects within 24 hours (the simulator) is trusted.
  const addDevice = (device: typeof GATE) =>
    tx.attendanceDevice.create({
      data: { tenantId, ...device, direction: 'BOTH', ...by },
      select: { id: true },
    });
  await addDevice(GATE);
  const staffRoom = await addDevice(STAFF_ROOM);

  // Students: the digits of their codes; a code without one, or shared, is left for an admin.
  const students = await tx.student.findMany({
    where: { deletedAt: null, status: 'ACTIVE', enrolments: { some: { academicYearId: year.id } } },
    orderBy: { studentCode: 'asc' },
    select: { id: true, studentCode: true },
  });
  const wanted = students.map((s) => ({
    ...s,
    deviceUserId: defaultStudentDeviceId(s.studentCode),
  }));
  const wantedBy = new Map<string, number>();
  for (const { deviceUserId } of wanted) {
    if (deviceUserId) wantedBy.set(deviceUserId, (wantedBy.get(deviceUserId) ?? 0) + 1);
  }
  const people: Prisma.DevicePersonCreateManyInput[] = [];
  for (const s of wanted) {
    if (s.deviceUserId === null || wantedBy.get(s.deviceUserId)! > 1) {
      console.log(`  ${s.studentCode}: no device ID (no default, or shared), skipped`);
      continue;
    }
    people.push({ tenantId, deviceUserId: s.deviceUserId, studentId: s.id, ...by });
  }

  // Staff: from the staff start, in profile order, never a number a student's code gives.
  const reserved = new Set(wanted.flatMap((s) => (s.deviceUserId ? [s.deviceUserId] : [])));
  const used = new Set(people.map((p) => p.deviceUserId));
  const pins = new Map<string, string>();
  let from = settings.staffDeviceIdStart;
  for (const member of ctx.staff) {
    const id = nextStaffDeviceId(from, used, reserved);
    if (id === null) throw new Error('Demo seed: no free staff device ID');
    used.add(id);
    from = Number(id) + 1;
    pins.set(member.userId, id);
    people.push({ tenantId, deviceUserId: id, staffUserId: member.userId, ...by });
  }
  await tx.devicePerson.createMany({ data: people });

  // The staff report counts a person's days from their profile's creation: date the profiles to
  // the start of the demo year, as the students are, keeping their order.
  const yearStart = wallClockToUtc(`${dateFromDb(year.startDate)} 00:00:00`, timezone).getTime();
  const profiles = await tx.staffProfile.findMany({
    orderBy: { createdAt: 'asc' },
    select: { userId: true, createdAt: true },
  });
  const first = profiles[0]?.createdAt.getTime() ?? yearStart;
  for (const p of profiles) {
    await tx.staffProfile.update({
      where: { tenantId_userId: { tenantId, userId: p.userId } },
      data: { createdAt: new Date(yearStart + p.createdAt.getTime() - first) },
    });
  }

  // A month of attendance for the staff whose attendance is kept (by default not an owner's).
  const holidays = await tx.holiday.findMany({ select: { startDate: true, endDate: true } });
  const isOff = (d: IsoDate) =>
    settings.weeklyOffDays.includes(isoWeekday(d)) ||
    holidays.some((h) => dateToDb(d) >= h.startDate && dateToDb(d) <= h.endDate);
  const plan = planStaffAttendance({
    dates: workingDaysBefore(todayIn(timezone), STAFF_HISTORY_DAYS, isOff),
    people: ctx.staff
      .filter((m) =>
        staffAttendanceTracked({ tracked: null, activeStaffRoles: m.roles.filter(isStaffRole) }),
      )
      .map((m) => ({ userId: m.userId, phone: m.phone, deviceUserId: pins.get(m.userId)! })),
    timeZone: timezone,
    office: {
      start: timeFromDb(settings.staffOfficeStart),
      end: timeFromDb(settings.staffOfficeEnd),
      lateGraceMin: settings.staffLateGraceMinutes,
      earlyGraceMin: settings.staffEarlyGraceMinutes,
    },
  });
  await tx.staffAttendanceDay.createMany({
    data: plan.days.map(({ date, ...day }) => ({
      tenantId,
      ...day,
      date: dateToDb(date),
      officeStart: settings.staffOfficeStart,
      officeEnd: settings.staffOfficeEnd,
      updatedById: day.source === 'MANUAL' ? admin.userId : null,
    })),
  });

  // Each punch as the receiver stores it and processing marks it: at the staff room, processed a
  // second after it arrived.
  return plan.punches.map((p) => {
    const processedAt = new Date(p.receivedAt.getTime() + 1000);
    return {
      tenantId,
      deviceId: staffRoom.id,
      deviceUserId: p.deviceUserId,
      // A zoneless TIMESTAMP: the wall clock as it is.
      deviceTime: new Date(`${p.deviceTime.replace(' ', 'T')}Z`),
      punchedAt: p.punchedAt,
      localDate: dateToDb(p.date),
      receivedAt: p.receivedAt,
      verifyType: 1,
      state: p.state,
      direction: punchDirection('BOTH', p.state),
      flags: [],
      processedAt,
      outcome: 'APPLIED',
      createdAt: p.receivedAt,
      updatedAt: processedAt,
    };
  });
}

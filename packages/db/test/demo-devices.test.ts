import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  dateFromDb,
  isoWeekday,
  localDateOf,
  localTimeOf,
  normalizeBdPhone,
  staffDay,
  staffMonth,
  wallClockToUtc,
} from '@jantrik/shared';
import { findOrCreateUser, withTenant, type PrismaClient, type Role } from '../src/index.js';
import {
  planStaffAttendance,
  seedDemoDevices,
  workingDaysBefore,
} from '../src/seed/demo-devices.js';
import { appClient, createTenant, ownerClient } from './helpers.js';

const TZ = 'Asia/Dhaka';
const OFFICE = { start: '08:00', end: '16:00', lateGraceMin: 10, earlyGraceMin: 10 };
const phone = (raw: string) => normalizeBdPhone(raw)!;

// Shapla's staff whose attendance is kept (the owner's is not), with their seeded device IDs.
const PEOPLE = [
  { userId: 'nasrin', phone: phone('01711000002'), deviceUserId: '9002' },
  { userId: 'rafiqul', phone: phone('01711000003'), deviceUserId: '9003' },
  { userId: 'shahana', phone: phone('01711000004'), deviceUserId: '9004' },
  { userId: 'sharmin', phone: phone('01911000999'), deviceUserId: '9005' },
];

const DATES = workingDaysBefore('2026-10-21', 30, (d) => isoWeekday(d) === 5);
const plan = () =>
  planStaffAttendance({ dates: DATES, people: PEOPLE, timeZone: TZ, office: OFFICE });

describe('demo staff attendance: the working days', () => {
  it('are the 30 calendar days before the seed date without off days, oldest first', () => {
    expect(DATES[0]).toBe('2026-09-21');
    expect(DATES.at(-1)).toBe('2026-10-20');
    // 30 days, 4 of them Fridays.
    expect(DATES).toHaveLength(26);
    expect(DATES.some((d) => isoWeekday(d) === 5)).toBe(false);
    expect([...DATES].sort()).toEqual(DATES);
  });

  it('skip holidays too', () => {
    const dates = workingDaysBefore('2026-10-21', 30, (d) => d === '2026-10-01');
    expect(dates).toHaveLength(29);
    expect(dates).not.toContain('2026-10-01');
    expect(dates[0]).toBe(addDays('2026-10-21', -30));
  });
});

describe('demo staff attendance: the plan', () => {
  it('is the same every time (derived from the device ID and the date only)', () => {
    expect(plan()).toEqual(plan());
  });

  it('has one in and one out punch per present day, as a device sends them', () => {
    const { punches, days } = plan();
    const present = days.filter((d) => d.status === 'PRESENT');
    expect(punches).toHaveLength(present.length * 2);
    for (const p of punches) {
      expect(wallClockToUtc(p.deviceTime, TZ)).toEqual(p.punchedAt);
      expect(p.deviceTime.slice(0, 10)).toBe(p.date);
      expect(localDateOf(p.punchedAt, TZ)).toBe(p.date);
      expect(p.receivedAt.getTime()).toBeGreaterThan(p.punchedAt.getTime());
      expect(p.receivedAt.getTime() - p.punchedAt.getTime()).toBeLessThan(60_000);
    }
    for (const person of PEOPLE) {
      for (const date of DATES) {
        const mine = punches.filter(
          (p) => p.deviceUserId === person.deviceUserId && p.date === date,
        );
        if (mine.length === 0) continue;
        expect(mine.map((p) => p.state)).toEqual([0, 1]);
        expect(mine[0]!.punchedAt.getTime()).toBeLessThan(mine[1]!.punchedAt.getTime());
      }
    }
  });

  it('keeps in times around 07:40–08:25 (some late) and out times around 15:30–16:30', () => {
    const { punches, days } = plan();
    const times = (state: 0 | 1) =>
      punches.filter((p) => p.state === state).map((p) => localTimeOf(p.punchedAt, TZ));
    for (const t of times(0)) expect(t >= '07:40:00' && t <= '08:25:59').toBe(true);
    for (const t of times(1)) expect(t >= '15:30:00' && t <= '16:30:59').toBe(true);
    const late = days.filter((d) => d.lateMinutes > 0);
    expect(late.length).toBeGreaterThanOrEqual(3);
    expect(late.length).toBeLessThan(days.length / 4);
    // Two early leaves, both before 15:50.
    const early = days.filter((d) => d.earlyMinutes > 0);
    expect(early.map((d) => d.userId).sort()).toEqual(['nasrin', 'rafiqul']);
    for (const d of early) expect(localTimeOf(d.outAt!, TZ) < '15:50:00').toBe(true);
  });

  it('computes each device day with staffDay from its punches and the office hours', () => {
    const { punches, days } = plan();
    const device = days.filter((d) => d.source === 'DEVICE');
    expect(device.every((d) => d.status === 'PRESENT' && d.reason === null)).toBe(true);
    for (const day of device) {
      const pin = PEOPLE.find((p) => p.userId === day.userId)!.deviceUserId;
      const mine = punches.filter((p) => p.deviceUserId === pin && p.date === day.date);
      const expected = staffDay({
        punches: mine.map((p) => p.punchedAt),
        timeZone: TZ,
        officeStart: OFFICE.start,
        officeEnd: OFFICE.end,
        lateGraceMin: OFFICE.lateGraceMin,
        earlyGraceMin: OFFICE.earlyGraceMin,
      });
      expect({
        inAt: day.inAt,
        outAt: day.outAt,
        lateMinutes: day.lateMinutes,
        earlyMinutes: day.earlyMinutes,
      }).toEqual(expected);
    }
  });

  it('gives a teacher one manual leave with a reason and leaves one day without a punch', () => {
    const { punches, days } = plan();
    const leave = days.filter((d) => d.status === 'LEAVE');
    expect(leave).toEqual([
      {
        userId: 'sharmin',
        date: expect.any(String),
        status: 'LEAVE',
        inAt: null,
        outAt: null,
        lateMinutes: 0,
        earlyMinutes: 0,
        source: 'MANUAL',
        reason: 'অসুস্থতার ছুটি',
      },
    ]);
    expect(punches.some((p) => p.deviceUserId === '9005' && p.date === leave[0]!.date)).toBe(false);

    // Every person-day has a row except one: the absent day.
    expect(days).toHaveLength(PEOPLE.length * DATES.length - 1);
    const missing = PEOPLE.flatMap((p) =>
      DATES.filter((date) => !days.some((d) => d.userId === p.userId && d.date === date)).map(
        (date) => ({ userId: p.userId, date }),
      ),
    );
    expect(missing).toEqual([{ userId: 'shahana', date: expect.any(String) }]);
    expect(punches.some((p) => p.deviceUserId === '9004' && p.date === missing[0]!.date)).toBe(
      false,
    );
  });
});

// ─────────── The seed in a real database (jantrik_test), as `pnpm db:seed` runs it ───────────

/** Shapla's staff: phone, name and roles (Nasrin has two). */
const SHAPLA_STAFF: [raw: string, name: string, roles: Role[]][] = [
  ['01711000001', 'Abdul Karim', ['OWNER']],
  ['01711000002', 'Nasrin Akter', ['TEACHER', 'ACCOUNTANT']],
  ['01711000003', 'Rafiqul Islam', ['ADMIN']],
  ['01711000004', 'Shahana Parvin', ['ACCOUNTANT']],
  ['01911000999', 'Sharmin Sultana', ['TEACHER']],
];
/** Enrolled this year. X-9002 takes the number the staff would get second. */
const CODES = ['SHS-2026-0001', 'SHS-2026-0102', 'X-9002', 'A-0123', 'B-123', 'NOCODE'];
const NOT_ENROLLED = 'SHS-2026-0003';
const HOLIDAY = '2026-10-01';

interface Seeded {
  tenantId: string;
  staff: { userId: string; phone: string; roles: Role[] }[];
  /** The staff profiles by (created_at, user_id) before the seed. */
  profileOrder: string[];
  logged: string[];
}

describe('the demo device seed in the database', () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  const tenantIds: string[] = [];
  const seeded: Seeded[] = [];
  /** The institute the checks look at: the last one seeded (its devices are still active). */
  const institute = () => seeded.at(-1)!;
  const userIdOf = (raw: string) => institute().staff.find((m) => m.phone === phone(raw))!.userId;

  const profileOrder = (tenantId: string) =>
    withTenant(app, tenantId, async (tx) =>
      (
        await tx.staffProfile.findMany({
          orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
          select: { userId: true },
        })
      ).map((p) => p.userId),
    );

  /** A serial number is active in one institute only: retire an institute's devices. */
  const retire = (tenantId: string) =>
    withTenant(app, tenantId, (tx) =>
      tx.attendanceDevice.updateMany({ data: { isActive: false } }),
    );

  /** An institute shaped like Shapla, then its devices seeded as `seedDemo` does. */
  async function seedInstitute(): Promise<Seeded> {
    const tenantId = (await createTenant(app)).id;
    tenantIds.push(tenantId);
    const staff = await withTenant(app, tenantId, async (tx) => {
      const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      const classLevel = await tx.classLevel.findFirstOrThrow({ orderBy: { sortOrder: 'asc' } });
      const out: Seeded['staff'] = [];
      for (const [raw, name, roles] of SHAPLA_STAFF) {
        const userId = await findOrCreateUser(tx, phone(raw), name);
        for (const role of roles) await tx.membership.create({ data: { tenantId, userId, role } });
        await tx.staffProfile.create({ data: { tenantId, userId, name, phone: phone(raw) } });
        out.push({ userId, phone: phone(raw), roles });
      }
      for (const code of [...CODES, NOT_ENROLLED]) {
        const student = await tx.student.create({
          data: { tenantId, studentCode: code, nameEn: code },
        });
        if (code === NOT_ENROLLED) continue;
        await tx.enrolment.create({
          data: {
            tenantId,
            studentId: student.id,
            academicYearId: year.id,
            classLevelId: classLevel.id,
          },
        });
      }
      await tx.holiday.create({
        data: {
          tenantId,
          startDate: new Date(HOLIDAY),
          endDate: new Date(HOLIDAY),
          nameBn: 'ছুটি',
          nameEn: 'Holiday',
        },
      });
      return out;
    });
    const before = await profileOrder(tenantId);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const punches = await withTenant(
        app,
        tenantId,
        (tx) => seedDemoDevices(tx, { tenantId, staff }),
        { timeout: 60_000 },
      );
      await withTenant(owner, tenantId, (tx) => tx.devicePunch.createMany({ data: punches }));
      const logged = log.mock.calls.map((c) => String(c[0]));
      return { tenantId, staff, profileOrder: before, logged };
    } finally {
      log.mockRestore();
    }
  }

  /** What a seed wrote, without ids and creation times. */
  const snapshot = (s: Seeded) =>
    withTenant(app, s.tenantId, async (tx) => {
      const phoneOf = new Map(s.staff.map((m) => [m.userId, m.phone]));
      const people = await tx.devicePerson.findMany({
        orderBy: { deviceUserId: 'asc' },
        select: {
          deviceUserId: true,
          staffUserId: true,
          student: { select: { studentCode: true } },
        },
      });
      const punches = await tx.devicePunch.findMany({
        orderBy: [{ deviceUserId: 'asc' }, { deviceTime: 'asc' }],
        select: {
          deviceUserId: true,
          deviceTime: true,
          punchedAt: true,
          localDate: true,
          receivedAt: true,
          verifyType: true,
          state: true,
          direction: true,
          flags: true,
          processedAt: true,
          outcome: true,
        },
      });
      const days = await tx.staffAttendanceDay.findMany({
        orderBy: [{ date: 'asc' }, { userId: 'asc' }],
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
      return {
        people: people.map((p) => [
          p.deviceUserId,
          p.student?.studentCode ?? phoneOf.get(p.staffUserId!),
        ]),
        punches,
        days: days.map(({ userId, date, ...d }) => ({
          phone: phoneOf.get(userId),
          date: dateFromDb(date),
          ...d,
        })),
      };
    });

  beforeAll(async () => {
    vi.stubEnv('JANTRIK_TEST_TODAY', '2026-10-21');
    app = appClient();
    owner = ownerClient();
    seeded.push(await seedInstitute());
    await retire(seeded[0]!.tenantId);
    seeded.push(await seedInstitute());
  }, 120_000);

  afterAll(async () => {
    for (const tenantId of tenantIds) await retire(tenantId);
    vi.unstubAllEnvs();
    await Promise.all([app.$disconnect(), owner.$disconnect()]);
  });

  it('writes the same on every run', async () => {
    const first = await snapshot(seeded[0]!);
    expect(first.punches.length).toBeGreaterThan(0);
    expect(await snapshot(seeded[1]!)).toEqual(first);
  });

  it('adds the two devices, registered now and never connected', async () => {
    const devices = await withTenant(app, institute().tenantId, (tx) =>
      tx.attendanceDevice.findMany({ orderBy: { serialNo: 'asc' } }),
    );
    expect(
      devices.map((d) => [d.serialNo, d.name, d.gate, d.direction, d.isActive, d.lastSeenAt]),
    ).toEqual([
      ['DEMO00000001', 'প্রধান ফটক', 'প্রধান ফটক', 'BOTH', true, null],
      ['DEMO00000002', 'শিক্ষকদের কক্ষ', 'শিক্ষকদের কক্ষ', 'BOTH', true, null],
    ]);
    for (const d of devices) {
      expect(Date.now() - d.createdAt.getTime()).toBeLessThan(10 * 60_000);
      expect(d.createdById).toBe(userIdOf('01711000003'));
    }
  });

  it('gives students the digits of their codes and staff numbers from 9001 in profile order', async () => {
    const { people } = await snapshot(institute());
    expect(people).toEqual([
      ['20260001', 'SHS-2026-0001'],
      ['20260102', 'SHS-2026-0102'],
      ['9001', phone('01711000001')],
      ['9002', 'X-9002'],
      // 9002 is a student's: the staff numbers skip it.
      ['9003', phone('01711000002')],
      ['9004', phone('01711000003')],
      ['9005', phone('01711000004')],
      ['9006', phone('01911000999')],
    ]);
    // A shared default and a code without digits are skipped and logged; the student not
    // enrolled this year gets nothing.
    expect(institute().logged).toEqual([
      '  A-0123: no device ID (no default, or shared), skipped',
      '  B-123: no device ID (no default, or shared), skipped',
      '  NOCODE: no device ID (no default, or shared), skipped',
    ]);
  });

  it('dates the staff profiles to the start of the demo year, keeping their order', async () => {
    const profiles = await withTenant(app, institute().tenantId, (tx) =>
      tx.staffProfile.findMany(),
    );
    expect(profiles).toHaveLength(SHAPLA_STAFF.length);
    for (const p of profiles) expect(localDateOf(p.createdAt, TZ)).toBe('2026-01-01');
    expect(await profileOrder(institute().tenantId)).toEqual(institute().profileOrder);
  });

  it('writes a day per working day: device days, a manual leave, none on the absent day or for the owner', async () => {
    const expected = workingDaysBefore(
      '2026-10-21',
      30,
      (d) => isoWeekday(d) === 5 || d === HOLIDAY,
    );
    expect(expected).toHaveLength(25);
    const rows = await withTenant(app, institute().tenantId, (tx) =>
      tx.staffAttendanceDay.findMany(),
    );
    expect(rows).toHaveLength(4 * 25 - 1);
    expect([...new Set(rows.map((r) => dateFromDb(r.date)))].sort()).toEqual(expected);
    expect(rows.some((r) => r.userId === userIdOf('01711000001'))).toBe(false);

    const manual = rows.filter((r) => r.source === 'MANUAL');
    expect(
      manual.map((r) => [r.userId, dateFromDb(r.date), r.status, r.reason, r.updatedById]),
    ).toEqual([
      [userIdOf('01911000999'), '2026-10-12', 'LEAVE', 'অসুস্থতার ছুটি', userIdOf('01711000003')],
    ]);
    for (const r of rows.filter((x) => x.source === 'DEVICE')) {
      expect(r).toMatchObject({ status: 'PRESENT', reason: null, updatedById: null, version: 1 });
      expect(r.officeStart.toISOString().slice(11, 16)).toBe('08:00');
      expect(r.officeEnd.toISOString().slice(11, 16)).toBe('16:00');
    }
    const shahana = rows.filter((r) => r.userId === userIdOf('01711000004'));
    expect(expected.filter((d) => !shahana.some((r) => dateFromDb(r.date) === d))).toEqual([
      '2026-10-17',
    ]);
  });

  it('stores the punches as a device sends them and processing marks them', async () => {
    const punches = await withTenant(app, institute().tenantId, (tx) =>
      tx.devicePunch.findMany({ include: { device: { select: { serialNo: true } } } }),
    );
    // Two a day for each of the 4 tracked staff, but for the leave and the absent day.
    expect(punches).toHaveLength(2 * (4 * 25 - 2));
    for (const p of punches) {
      expect(p.device.serialNo).toBe('DEMO00000002');
      expect(['9003', '9004', '9005', '9006']).toContain(p.deviceUserId);
      expect(p).toMatchObject({
        verifyType: 1,
        flags: [],
        outcome: 'APPLIED',
        sourceIp: null,
        review: null,
        direction: p.state === 0 ? 'IN' : 'OUT',
      });
      expect(p.processedAt!.getTime()).toBeGreaterThan(p.receivedAt.getTime());
      expect(p.receivedAt.getTime()).toBeGreaterThan(p.punchedAt.getTime());
    }
    // The zoneless device time is punched_at's wall clock in the institute's zone.
    const [row] = await withTenant(
      app,
      institute().tenantId,
      (tx) => tx.$queryRaw<{ mismatched: bigint }[]>`
        SELECT count(*) AS mismatched FROM device_punches
        WHERE device_time <> (punched_at AT TIME ZONE 'Asia/Dhaka')
           OR local_date <> (punched_at AT TIME ZONE 'Asia/Dhaka')::date`,
    );
    expect(row!.mismatched).toBe(0n);
  });

  it('leaves registers, commands and the device settings alone', async () => {
    const [sessions, commands, sources, settings] = await withTenant(
      app,
      institute().tenantId,
      (tx) =>
        Promise.all([
          tx.attendanceSession.count(),
          tx.deviceCommand.count(),
          tx.deviceSourceIp.count(),
          tx.attendanceSettings.findFirstOrThrow(),
        ]),
    );
    expect([sessions, commands, sources]).toEqual([0, 0, 0]);
    expect(settings).toMatchObject({
      deviceAutoMark: false,
      entrySmsEnabled: false,
      exitSmsEnabled: false,
    });
  });

  it('reads as the staff report shows October: late and early days, the leave, the absent day', async () => {
    const { profiles, rows } = await withTenant(app, institute().tenantId, async (tx) => ({
      profiles: await tx.staffProfile.findMany(),
      rows: await tx.staffAttendanceDay.findMany(),
    }));
    const days = Array.from({ length: 31 }, (_, i) => {
      const date = `2026-10-${String(i + 1).padStart(2, '0')}`;
      return { date, off: isoWeekday(date) === 5 || date === HOLIDAY };
    });
    const tracked = SHAPLA_STAFF.filter(([, , roles]) => roles.join() !== 'OWNER');
    const month = staffMonth({
      month: '2026-10',
      days,
      today: '2026-10-21',
      people: tracked.map(([raw]) => ({
        key: userIdOf(raw),
        since: localDateOf(profiles.find((p) => p.userId === userIdOf(raw))!.createdAt, TZ),
      })),
      rows: rows.map((r) => ({
        key: r.userId,
        date: dateFromDb(r.date),
        status: r.status,
        lateMinutes: r.lateMinutes,
        earlyMinutes: r.earlyMinutes,
      })),
      officeEndPassedToday: false,
    });
    const cell = (raw: string, date: string) =>
      month.find((m) => m.key === userIdOf(raw))!.cells[Number(date.slice(8)) - 1];
    expect(cell('01711000004', '2026-10-17')).toBe('ABSENT');
    expect(cell('01911000999', '2026-10-12')).toBe('LEAVE');
    expect(cell('01711000002', '2026-10-18')).toMatch(/EARLY/);
    expect(cell('01711000003', '2026-10-07')).toMatch(/EARLY/);
    const total = (k: 'absent' | 'leave' | 'early' | 'late') =>
      month.reduce((n, m) => n + m.totals[k], 0);
    expect([total('absent'), total('leave'), total('early')]).toEqual([1, 1, 2]);
    expect(total('late')).toBeGreaterThan(0);
  });
});

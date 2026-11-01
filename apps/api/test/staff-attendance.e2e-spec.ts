import { randomUUID } from 'node:crypto';
import type { Role } from '@jantrik/db';
import {
  STAFF_CELL_CODES,
  addDays,
  dateFromDb,
  type AttendanceSettings,
  type IsoDate,
  type StaffDayPerson,
  type StaffDayRecord,
  type StaffDayReport,
  type StaffMonthPerson,
  type StaffMonthReport,
} from '@jantrik/shared';
import { timeFromDb } from '../src/attendance/attendance-settings.service.js';
import { FakeClock } from './support/clock.js';
import {
  addMember,
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  type Harness,
} from './support/harness.js';
import { createIngestHarness, type IngestHarness } from './support/ingest.js';
import { dhaka, punchFixtures, type Institute } from './support/punches.js';

// Staff attendance for owners and admins: the day view, manual entries, the tracked switch, and
// the month report with its CSVs. Device punches come through the receiver (@jantrik/device-sim)
// and the devices worker; both apps share one FakeClock. 2026-10-21 is a Wednesday. Office hours
// 09:00–17:00 with 10 minutes' grace either way; no weekly off days.

const DAY = '2026-10-21';
const MONTH = '2026-10';
const at = (time: string, day = DAY) => dhaka(day, time);
const iso = (time: string, day = DAY) => at(time, day).toISOString();
const HOURS: Partial<AttendanceSettings> = {
  staffOfficeStart: '09:00',
  staffOfficeEnd: '17:00',
  staffLateGraceMinutes: 10,
  staffEarlyGraceMinutes: 10,
};
/** When everyone here became staff, unless a test says otherwise. */
const SINCE = '2026-09-01';
const NOBODY = { id: '', name: '', nameBn: null };

type Ctx = Institute & { me: { userId: string; token: string } };

describe('staff attendance', () => {
  const clock = new FakeClock(at('08:00:00'));
  let h: Harness;
  let ingest: IngestHarness;
  const f = punchFixtures(
    () => h,
    () => ingest,
    clock,
  );

  beforeAll(async () => {
    h = await createHarness({ clock });
    ingest = await createIngestHarness({ clock });
  });
  afterAll(async () => {
    await ingest.queue.obliterate({ force: true });
    await ingest.close();
    await h.close();
  });
  beforeEach(() => clock.set(at('08:00:00')));

  const get = (token: string, path: string, query: Record<string, string> = {}) =>
    http(h).get(path).query(query).set(bearer(token));
  const put = (token: string, path: string, body: object) =>
    http(h).put(path).set(bearer(token)).send(body);

  const login = async (tenantId: string, roles: Role[]) => {
    const m = await addMember(h, tenantId, { roles });
    return { userId: m.userId, token: (await otpLogin(h, m.phone)).accessToken };
  };

  /** An institute (office hours above, a device) with an admin; all its staff since SINCE. */
  const setup = async (): Promise<Ctx> => {
    const s = await f.institute(HOURS);
    const me = await login(s.tenantId, ['ADMIN']);
    await f.inTenant(s.tenantId, (tx) =>
      tx.staffProfile.updateMany({ data: { createdAt: at('00:00:00', SINCE) } }),
    );
    return { ...s, me };
  };

  /** A staff member with a profile (staff since `since`), and a device ID when given. */
  const person = async (
    s: Ctx,
    opts: {
      roles?: Role[];
      name?: string;
      nameBn?: string;
      deviceUserId?: string;
      since?: IsoDate;
    } = {},
  ) => {
    const { userId } = await addMember(h, s.tenantId, {
      roles: opts.roles ?? ['TEACHER'],
      name: opts.name ?? 'Staff Member',
    });
    await f.inTenant(s.tenantId, (tx) =>
      tx.staffProfile.update({
        where: { tenantId_userId: { tenantId: s.tenantId, userId } },
        data: { nameBn: opts.nameBn ?? null, createdAt: at('00:00:00', opts.since ?? SINCE) },
      }),
    );
    if (opts.deviceUserId) {
      await f.map(s.tenantId, [{ deviceUserId: opts.deviceUserId, staffUserId: userId }]);
    }
    return userId;
  };

  const dayView = async (token: string, date?: IsoDate) =>
    (await get(token, '/staff-attendance/day', date ? { date } : {}).expect(200))
      .body as StaffDayReport;
  const personOn = (report: StaffDayReport, userId: string): StaffDayPerson => {
    const found = report.people.find((p) => p.userId === userId);
    if (!found) throw new Error(`${userId} is not in the day view`);
    return found;
  };
  const entry = (token: string, userId: string, date: IsoDate, body: object) =>
    put(token, `/staff-attendance/${userId}/${date}`, body);
  const tracked = (token: string, userId: string, value: boolean | null) =>
    put(token, `/staff-attendance/${userId}/tracked`, { tracked: value });
  const month = async (token: string) =>
    (await get(token, '/staff-attendance/month', { month: MONTH }).expect(200))
      .body as StaffMonthReport;
  const csv = async (token: string, query: Record<string, string>) => {
    const res = await get(token, '/staff-attendance/month/csv', { month: MONTH, ...query })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
      })
      .expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    return res.body as string;
  };
  /** CSV text → rows (the test data has no commas or quotes). */
  const rowsOf = (text: string) => {
    expect(text.startsWith('﻿')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    return text
      .slice(1, -2)
      .split('\r\n')
      .map((line) => line.split(','));
  };
  const staffDay = async (tenantId: string, userId: string, date = DAY) =>
    (await f.staffDays(tenantId)).find((d) => d.userId === userId && dateFromDb(d.date) === date);

  describe('days from device punches', () => {
    it('late and early at the grace boundaries, a single punch, and an out 29 or 30 minutes after the in', async () => {
      const s = await setup();
      const onTime = await person(s, { deviceUserId: '9001' });
      const late = await person(s, { deviceUserId: '9002' });
      const single = await person(s, { roles: ['ACCOUNTANT'], deviceUserId: '9003' });
      const short = await person(s, { roles: ['STAFF'], deviceUserId: '9004' });
      const thirty = await person(s, { roles: ['STAFF'], deviceUserId: '9005' });
      clock.set(at('17:30:00'));
      await f.upload(f.sim(s.device.serialNo), DAY, [
        ['9001', '09:10:00'],
        ['9001', '16:50:00', true],
        ['9002', '09:10:01'],
        ['9002', '16:49:59', true],
        ['9003', '08:55:00'],
        ['9004', '09:00:00'],
        ['9004', '09:29:00'],
        ['9005', '09:00:00'],
        ['9005', '09:30:00'],
      ]);
      await f.settled(s.tenantId);

      const view = await dayView(s.me.token, DAY);
      expect(personOn(view, onTime)).toMatchObject({
        roles: ['TEACHER'],
        tracked: true,
        trackedSetting: null,
        state: null,
        day: {
          status: 'PRESENT',
          inAt: iso('09:10:00'),
          outAt: iso('16:50:00'),
          lateMinutes: 0,
          earlyMinutes: 0,
          source: 'DEVICE',
          reason: null,
          version: 1,
          updatedBy: NOBODY,
        },
        punches: [
          { punchedAt: iso('09:10:00'), deviceName: 'Gate' },
          { punchedAt: iso('16:50:00'), deviceName: 'Gate' },
        ],
      });
      expect(personOn(view, late).day).toMatchObject({
        inAt: iso('09:10:01'),
        outAt: iso('16:49:59'),
        lateMinutes: 10,
        earlyMinutes: 10,
      });
      expect(personOn(view, single).day).toMatchObject({
        inAt: iso('08:55:00'),
        outAt: null,
        lateMinutes: 0,
        earlyMinutes: 0,
      });
      expect(personOn(view, short).day).toMatchObject({
        inAt: iso('09:00:00'),
        outAt: null,
        earlyMinutes: 0,
      });
      expect(personOn(view, short).punches).toHaveLength(2);
      expect(personOn(view, thirty).day).toMatchObject({
        inAt: iso('09:00:00'),
        outAt: iso('09:30:00'),
        earlyMinutes: 450,
      });
    });
  });

  describe('manual entries', () => {
    it('late and early at the boundaries from typed times (Bangla digits too), kept as typed; MANUAL with the caller as updater; audited', async () => {
      const s = await setup();
      const a = await person(s, { name: 'Amina Akter' });
      const b = await person(s);
      const c = await person(s);
      const save = (userId: string, body: object) =>
        entry(s.me.token, userId, DAY, { reason: 'Device was down', baseVersion: 0, ...body });

      const saved = (
        await save(a, { status: 'PRESENT', inAt: '09:10', outAt: '16:50' }).expect(200)
      ).body as StaffDayRecord;
      expect(saved).toEqual({
        status: 'PRESENT',
        inAt: iso('09:10:00'),
        outAt: iso('16:50:00'),
        lateMinutes: 0,
        earlyMinutes: 0,
        source: 'MANUAL',
        reason: 'Device was down',
        version: 1,
        updatedBy: { id: s.me.userId, name: 'Test User', nameBn: null },
      });
      expect(
        (await save(b, { status: 'PRESENT', inAt: '০৯:১১', outAt: '১৬:৪৯' }).expect(200)).body,
      ).toMatchObject({ inAt: iso('09:11:00'), lateMinutes: 11, earlyMinutes: 11 });
      // No 30-minute rule for typed times: the out time is what the admin typed.
      expect(
        (await save(c, { status: 'PRESENT', inAt: '09:00', outAt: '09:20' }).expect(200)).body,
      ).toMatchObject({ outAt: iso('09:20:00'), lateMinutes: 0, earlyMinutes: 460 });

      const row = (await staffDay(s.tenantId, a))!;
      expect({
        source: row.source,
        updatedById: row.updatedById,
        officeStart: timeFromDb(row.officeStart),
        officeEnd: timeFromDb(row.officeEnd),
      }).toEqual({
        source: 'MANUAL',
        updatedById: s.me.userId,
        officeStart: '09:00',
        officeEnd: '17:00',
      });

      // A leave keeps no times; the change is audited with both sides.
      const leave = (
        await save(a, {
          status: 'LEAVE',
          inAt: '09:00',
          outAt: '17:00',
          reason: '  অসুস্থ ছিলেন  ',
          baseVersion: 1,
        }).expect(200)
      ).body as StaffDayRecord;
      expect(leave).toMatchObject({
        status: 'LEAVE',
        inAt: null,
        outAt: null,
        lateMinutes: 0,
        earlyMinutes: 0,
        reason: 'অসুস্থ ছিলেন',
        version: 2,
      });
      const present = {
        userId: a,
        date: DAY,
        status: 'PRESENT',
        inAt: iso('09:10:00'),
        outAt: iso('16:50:00'),
        lateMinutes: 0,
        earlyMinutes: 0,
        officeStart: '09:00',
        officeEnd: '17:00',
        source: 'MANUAL',
        reason: 'Device was down',
      };
      expect(await f.audits(s.tenantId, 'staff_attendance_day', row.id)).toEqual([
        { action: 'CREATE', actorUserId: s.me.userId, oldValues: null, newValues: present },
        {
          action: 'UPDATE',
          actorUserId: s.me.userId,
          oldValues: present,
          newValues: {
            ...present,
            status: 'LEAVE',
            inAt: null,
            outAt: null,
            reason: 'অসুস্থ ছিলেন',
          },
        },
      ]);
    });

    it('needs a reason of 3 or more characters, an in time for PRESENT, an out not before the in, and no future date', async () => {
      const s = await setup();
      const a = await person(s);
      const save = (body: object, date = DAY) =>
        entry(s.me.token, a, date, {
          status: 'PRESENT',
          inAt: '09:00',
          reason: 'Device was down',
          baseVersion: 0,
          ...body,
        });
      for (const reason of ['ab', '   ', '']) await save({ reason }).expect(400);
      await save({ reason: undefined }).expect(400);
      expect((await save({ inAt: null }).expect(422)).body).toMatchObject({
        code: 'IN_TIME_REQUIRED',
      });
      expect((await save({ inAt: undefined, outAt: '10:00' }).expect(422)).body).toMatchObject({
        code: 'IN_TIME_REQUIRED',
      });
      expect((await save({ inAt: '10:00', outAt: '09:59' }).expect(422)).body).toMatchObject({
        code: 'OUT_BEFORE_IN',
      });
      expect((await save({}, addDays(DAY, 1)).expect(422)).body).toMatchObject({
        code: 'FUTURE_DATE',
        today: DAY,
      });
      expect(
        (await get(s.me.token, '/staff-attendance/day', { date: addDays(DAY, 1) }).expect(422))
          .body,
      ).toMatchObject({ code: 'FUTURE_DATE', today: DAY });
      expect(await staffDay(s.tenantId, a)).toBeUndefined();
      // Out equal to in is fine; a past date is fine.
      await save({ inAt: '10:00', outAt: '10:00' }).expect(200);
      await save({}, addDays(DAY, -30)).expect(200);
    });

    it('wins over the device: based on its version, and a later punch changes nothing; a stale base version is a 409 with the current day', async () => {
      const s = await setup();
      const t = await person(s, { deviceUserId: '9001' });
      const reader = f.sim(s.device.serialNo);
      clock.set(at('09:20:00'));
      await f.upload(reader, DAY, [['9001', '09:15:00']]);
      await f.settled(s.tenantId);
      const device = personOn(await dayView(s.me.token), t).day!;
      expect(device).toMatchObject({ source: 'DEVICE', version: 1, lateMinutes: 15 });

      const body = { status: 'PRESENT', inAt: '09:00', reason: 'Was at the gate early' };
      expect(
        (await entry(s.me.token, t, DAY, { ...body, baseVersion: 0 }).expect(409)).body,
      ).toEqual({
        statusCode: 409,
        code: 'VERSION_CONFLICT',
        message: expect.any(String) as string,
        day: device,
      });
      const saved = (await entry(s.me.token, t, DAY, { ...body, baseVersion: 1 }).expect(200))
        .body as StaffDayRecord;
      expect(saved).toMatchObject({
        source: 'MANUAL',
        version: 2,
        inAt: iso('09:00:00'),
        outAt: null,
        lateMinutes: 0,
      });

      clock.set(at('17:30:00'));
      await f.upload(reader, DAY, [['9001', '17:20:00', true]]);
      await f.settled(s.tenantId);
      const after = personOn(await dayView(s.me.token), t);
      expect(after.day).toEqual(saved);
      expect(after.punches.map((p) => p.punchedAt)).toEqual([iso('09:15:00'), iso('17:20:00')]);

      expect(
        (await entry(s.me.token, t, DAY, { ...body, baseVersion: 1 }).expect(409)).body,
      ).toMatchObject({ code: 'VERSION_CONFLICT', day: saved });
      // No day yet, but a base version: the day it was based on is gone or never was.
      const other = await person(s);
      expect(
        (await entry(s.me.token, other, DAY, { ...body, baseVersion: 3 }).expect(409)).body,
      ).toMatchObject({ code: 'VERSION_CONFLICT', day: null });
    });

    it('only for active staff here', async () => {
      const s = await setup();
      const other = await setup();
      const disabled = await person(s);
      await f.inTenant(s.tenantId, (tx) =>
        tx.membership.updateMany({ where: { userId: disabled }, data: { status: 'DISABLED' } }),
      );
      const guardian = (await addMember(h, s.tenantId, { roles: ['GUARDIAN'] })).userId;
      const elsewhere = await person(other);
      for (const userId of [disabled, guardian, elsewhere, randomUUID()]) {
        expect(
          (
            await entry(s.me.token, userId, DAY, {
              status: 'LEAVE',
              reason: 'Family matter',
              baseVersion: 0,
            }).expect(422)
          ).body,
        ).toMatchObject({ code: 'NOT_STAFF' });
        expect((await tracked(s.me.token, userId, true).expect(422)).body).toMatchObject({
          code: 'NOT_STAFF',
        });
      }
      await entry(s.me.token, 'not-a-uuid', DAY, {}).expect(400);
    });
  });

  describe('the tracked switch', () => {
    it('owners are untracked by default; the switch turns anyone on or off and back to the default; audited', async () => {
      const s = await setup();
      const owner = await person(s, { roles: ['OWNER'] });
      const teacher = await person(s);
      const yesterday = addDays(DAY, -1);
      const state = async (userId: string) => {
        const p = personOn(await dayView(s.me.token, yesterday), userId);
        return [p.tracked, p.trackedSetting, p.state];
      };
      expect(await state(owner)).toEqual([false, null, 'NONE']);
      expect(await state(teacher)).toEqual([true, null, 'ABSENT']);
      expect((await month(s.me.token)).people.map((p) => p.userId)).not.toContain(owner);

      expect((await tracked(s.me.token, owner, true).expect(200)).body).toEqual({
        userId: owner,
        tracked: true,
        trackedSetting: true,
      });
      expect(await state(owner)).toEqual([true, true, 'ABSENT']);
      expect((await month(s.me.token)).people.map((p) => p.userId)).toContain(owner);
      expect((await tracked(s.me.token, teacher, false).expect(200)).body).toEqual({
        userId: teacher,
        tracked: false,
        trackedSetting: false,
      });
      expect(await state(teacher)).toEqual([false, false, 'NONE']);
      expect((await month(s.me.token)).people.map((p) => p.userId)).not.toContain(teacher);

      await tracked(s.me.token, owner, null).expect(200);
      await tracked(s.me.token, teacher, null).expect(200);
      expect(await state(owner)).toEqual([false, null, 'NONE']);
      expect(await state(teacher)).toEqual([true, null, 'ABSENT']);

      const profile = await f.inTenant(s.tenantId, (tx) =>
        tx.staffProfile.findFirstOrThrow({ where: { userId: owner }, select: { id: true } }),
      );
      expect(await f.audits(s.tenantId, 'staff_profile', profile.id)).toEqual([
        {
          action: 'UPDATE',
          actorUserId: s.me.userId,
          oldValues: { userId: owner, attendanceTracked: null },
          newValues: { userId: owner, attendanceTracked: true },
        },
        {
          action: 'UPDATE',
          actorUserId: s.me.userId,
          oldValues: { userId: owner, attendanceTracked: true },
          newValues: { userId: owner, attendanceTracked: null },
        },
      ]);
      await put(s.me.token, `/staff-attendance/${owner}/tracked`, {}).expect(400);
    });
  });

  describe('the day view', () => {
    it('days without a row: ABSENT, NOT_YET before office end today, OFF on a holiday, NONE before someone was staff', async () => {
      const s = await setup();
      await http(h)
        .post('/attendance/holidays')
        .set(bearer(s.me.token))
        .send({ startDate: '2026-10-19', endDate: '2026-10-19', nameBn: 'ছুটি', nameEn: 'Holiday' })
        .expect(201);
      const old = await person(s);
      const fresh = await person(s, { since: DAY });
      const left = await person(s, { name: 'Left Teacher' });
      await entry(s.me.token, left, '2026-10-20', {
        status: 'LEAVE',
        reason: 'Approved leave',
        baseVersion: 0,
      }).expect(200);
      await f.inTenant(s.tenantId, (tx) =>
        tx.membership.updateMany({ where: { userId: left }, data: { status: 'DISABLED' } }),
      );

      clock.set(at('16:59:59'));
      let today = await dayView(s.me.token);
      expect({ today: today.today, date: today.date, off: today.nonWorkingDay }).toEqual({
        today: DAY,
        date: DAY,
        off: null,
      });
      expect(today.officeHours).toEqual({
        start: '09:00',
        end: '17:00',
        lateGraceMinutes: 10,
        earlyGraceMinutes: 10,
      });
      expect([personOn(today, old).state, personOn(today, fresh).state]).toEqual([
        'NOT_YET',
        'NOT_YET',
      ]);
      expect(today.people.map((p) => p.userId)).not.toContain(left);

      clock.set(at('17:00:00'));
      today = await dayView(s.me.token);
      expect([personOn(today, old).state, personOn(today, fresh).state]).toEqual([
        'ABSENT',
        'ABSENT',
      ]);
      expect(personOn(today, old)).toMatchObject({ day: null, punches: [] });

      const yesterday = await dayView(s.me.token, '2026-10-20');
      expect([personOn(yesterday, old).state, personOn(yesterday, fresh).state]).toEqual([
        'ABSENT',
        'NONE',
      ]);
      // No longer staff: listed for the stored day only.
      expect(personOn(yesterday, left)).toMatchObject({
        name: 'Left Teacher',
        roles: [],
        tracked: false,
        state: null,
        day: { status: 'LEAVE', reason: 'Approved leave' },
      });

      const holiday = await dayView(s.me.token, '2026-10-19');
      expect(holiday.nonWorkingDay).toEqual({
        reason: 'HOLIDAY',
        nameBn: 'ছুটি',
        nameEn: 'Holiday',
      });
      expect([personOn(holiday, old).state, personOn(holiday, fresh).state]).toEqual([
        'OFF',
        'OFF',
      ]);
    });
  });

  describe('the month', () => {
    it('cells and totals by staffMonth with each stored day; both CSVs agree with it (BOM, CRLF, ASCII digits); later office hours change no past day', async () => {
      const s = await setup();
      await http(h)
        .post('/attendance/holidays')
        .set(bearer(s.me.token))
        .send({
          startDate: '2026-10-10',
          endDate: '2026-10-10',
          nameBn: 'পূজার ছুটি',
          nameEn: 'Puja holiday',
        })
        .expect(201);
      const a = await person(s, {
        name: 'Amina Akter',
        nameBn: 'আমিনা আক্তার',
        deviceUserId: '9001',
      });
      const b = await person(s, { name: 'Babul Mia' });
      const left = await person(s, { name: 'Left Teacher' });
      const owner = await person(s, { roles: ['OWNER'], name: 'Owner Only' });
      const save = (userId: string, date: IsoDate, body: object) =>
        entry(s.me.token, userId, date, { baseVersion: 0, ...body }).expect(200);
      await save(a, '2026-10-01', {
        status: 'PRESENT',
        inAt: '09:00',
        outAt: '17:00',
        reason: 'Device was down',
      });
      await save(a, '2026-10-02', {
        status: 'PRESENT',
        inAt: '09:25',
        outAt: '17:00',
        reason: 'Bus was late',
      });
      await save(a, '2026-10-05', { status: 'LEAVE', reason: 'অসুস্থ' });
      await save(b, '2026-10-06', {
        status: 'PRESENT',
        inAt: '09:00',
        outAt: '16:00',
        reason: 'Left early',
      });
      await save(b, '2026-10-07', {
        status: 'PRESENT',
        inAt: '09:30',
        outAt: '16:30',
        reason: 'Both ways',
      });
      await save(b, '2026-10-08', { status: 'ABSENT', reason: 'Did not come' });
      await save(left, '2026-10-03', { status: 'PRESENT', inAt: '09:00', reason: 'Last day' });
      await f.inTenant(s.tenantId, (tx) =>
        tx.membership.updateMany({ where: { userId: left }, data: { status: 'DISABLED' } }),
      );
      // Today (before office end) from the device: late 15.
      clock.set(at('09:20:00'));
      await f.upload(f.sim(s.device.serialNo), DAY, [['9001', '09:15:00']]);
      await f.settled(s.tenantId);

      const report = await month(s.me.token);
      expect(report.month).toBe(MONTH);
      expect(report.days).toHaveLength(31);
      expect(report.days[0]).toEqual({ date: '2026-10-01', off: false });
      expect(report.days[9]).toEqual({
        date: '2026-10-10',
        off: true,
        holidayName: { bn: 'পূজার ছুটি', en: 'Puja holiday' },
      });
      const byId = (userId: string): StaffMonthPerson => {
        const found = report.people.find((p) => p.userId === userId);
        if (!found) throw new Error(`${userId} is not in the month`);
        return found;
      };
      expect(report.people.map((p) => p.userId)).not.toContain(owner);
      const absentUntil = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, () => 'ABSENT');
      const none = (n: number) => Array.from({ length: n }, () => 'NONE');

      expect(byId(a)).toMatchObject({
        name: 'Amina Akter',
        nameBn: 'আমিনা আক্তার',
        roles: ['TEACHER'],
      });
      expect(byId(a).cells).toEqual([
        'PRESENT',
        'LATE',
        ...absentUntil(3, 4),
        'LEAVE',
        ...absentUntil(6, 9),
        'OFF',
        ...absentUntil(11, 20),
        'LATE',
        ...none(10),
      ]);
      expect(byId(a).totals).toEqual({
        present: 3,
        late: 2,
        early: 0,
        absent: 16,
        leave: 1,
        lateMinutes: 40,
        earlyMinutes: 0,
      });
      expect(byId(a).details).toEqual([
        {
          date: '2026-10-01',
          status: 'PRESENT',
          inAt: iso('09:00:00', '2026-10-01'),
          outAt: iso('17:00:00', '2026-10-01'),
          lateMinutes: 0,
          earlyMinutes: 0,
          source: 'MANUAL',
          reason: 'Device was down',
        },
        expect.objectContaining({ date: '2026-10-02', lateMinutes: 25 }),
        {
          date: '2026-10-05',
          status: 'LEAVE',
          inAt: null,
          outAt: null,
          lateMinutes: 0,
          earlyMinutes: 0,
          source: 'MANUAL',
          reason: 'অসুস্থ',
        },
        {
          date: DAY,
          status: 'PRESENT',
          inAt: iso('09:15:00'),
          outAt: null,
          lateMinutes: 15,
          earlyMinutes: 0,
          source: 'DEVICE',
          reason: null,
        },
      ]);
      expect(byId(b).cells.slice(5, 8)).toEqual(['EARLY', 'LATE_EARLY', 'ABSENT']);
      expect(byId(b).totals).toEqual({
        present: 2,
        late: 1,
        early: 2,
        absent: 17,
        leave: 0,
        lateMinutes: 30,
        earlyMinutes: 90,
      });
      // No longer staff: listed for their stored day, never absent.
      expect(byId(left)).toMatchObject({ roles: [], totals: { present: 1, absent: 0 } });
      expect(byId(left).cells.filter((c) => c !== 'NONE' && c !== 'OFF')).toEqual(['PRESENT']);

      // The grid CSV: one row per person, the codes, the same totals.
      for (const locale of ['bn', 'en'] as const) {
        const text = await csv(s.me.token, { locale, kind: 'grid' });
        expect(text).not.toMatch(/[০-৯]/);
        const [header, ...rows] = rowsOf(text);
        expect(header).toHaveLength(1 + 31 + 7);
        expect(header!.slice(1, 32)).toEqual(Array.from({ length: 31 }, (_, i) => String(i + 1)));
        expect(rows).toHaveLength(report.people.length);
        for (const p of report.people) {
          const name = locale === 'bn' ? (p.nameBn ?? p.name) : p.name;
          const row = rows.find((r) => r[0] === name && r.length === header!.length);
          expect(row, name).toBeDefined();
          const codes: Record<string, string> = STAFF_CELL_CODES[locale];
          expect(row!.slice(1, 32)).toEqual(p.cells.map((c) => codes[c] ?? ''));
          const t = p.totals;
          expect(row!.slice(32).map(Number)).toEqual([
            t.present,
            t.late,
            t.early,
            t.absent,
            t.leave,
            t.lateMinutes,
            t.earlyMinutes,
          ]);
        }
      }
      const bnGrid = rowsOf(await csv(s.me.token, { locale: 'bn' }));
      expect(bnGrid.find((r) => r[0] === 'আমিনা আক্তার')!.slice(1, 6)).toEqual([
        'উ',
        'দে',
        'অ',
        'অ',
        'ছু',
      ]);

      // The per-day CSV: a row per stored day, adding up to the same totals.
      const days = rowsOf(await csv(s.me.token, { locale: 'bn', kind: 'days' }));
      expect(days[0]).toHaveLength(9);
      expect(days.slice(1)).toHaveLength(report.people.reduce((n, p) => n + p.details.length, 0));
      expect(days.filter((r) => r[1] === 'আমিনা আক্তার')).toEqual([
        [
          '2026-10-01',
          'আমিনা আক্তার',
          'উপস্থিত',
          '09:00',
          '17:00',
          '0',
          '0',
          'হাতে',
          'Device was down',
        ],
        [
          '2026-10-02',
          'আমিনা আক্তার',
          'উপস্থিত',
          '09:25',
          '17:00',
          '25',
          '0',
          'হাতে',
          'Bus was late',
        ],
        ['2026-10-05', 'আমিনা আক্তার', 'ছুটি', '', '', '0', '0', 'হাতে', 'অসুস্থ'],
        [DAY, 'আমিনা আক্তার', 'উপস্থিত', '09:15', '', '15', '0', 'ডিভাইস', ''],
      ]);
      const en = rowsOf(await csv(s.me.token, { locale: 'en', kind: 'days' }));
      expect(en.filter((r) => r[1] === 'Babul Mia')).toEqual([
        ['2026-10-06', 'Babul Mia', 'Present', '09:00', '16:00', '0', '60', 'Manual', 'Left early'],
        ['2026-10-07', 'Babul Mia', 'Present', '09:30', '16:30', '30', '30', 'Manual', 'Both ways'],
        ['2026-10-08', 'Babul Mia', 'Absent', '', '', '0', '0', 'Manual', 'Did not come'],
      ]);
      for (const p of report.people) {
        const mine = en.filter((r) => r[1] === p.name);
        const sum = (i: number) => mine.reduce((n, r) => n + Number(r[i]), 0);
        expect(
          {
            present: mine.filter((r) => r[2] === 'Present').length,
            leave: mine.filter((r) => r[2] === 'Leave').length,
            late: mine.filter((r) => Number(r[5]) > 0).length,
            early: mine.filter((r) => Number(r[6]) > 0).length,
            lateMinutes: sum(5),
            earlyMinutes: sum(6),
          },
          p.name,
        ).toEqual({
          present: p.totals.present,
          leave: p.totals.leave,
          late: p.totals.late,
          early: p.totals.early,
          lateMinutes: p.totals.lateMinutes,
          earlyMinutes: p.totals.earlyMinutes,
        });
      }

      // New office hours judge new days only: the month reads what each day was judged by.
      await f.putSettings(s.me.token, { staffOfficeStart: '10:00', staffOfficeEnd: '18:00' });
      expect(await month(s.me.token)).toEqual(report);

      await get(s.me.token, '/staff-attendance/month').expect(400);
      await get(s.me.token, '/staff-attendance/month/csv', { month: MONTH, kind: 'rows' }).expect(
        400,
      );
    });
  });

  describe('access', () => {
    it('teachers, accountants and guardians get 403; so does an institute without attendance', async () => {
      const s = await setup();
      const target = await person(s);
      // One request at a time: each supertest request starts the server when it is made.
      const calls = (token: string) => [
        () => get(token, '/staff-attendance/day'),
        () => get(token, '/staff-attendance/month', { month: MONTH }),
        () => get(token, '/staff-attendance/month/csv', { month: MONTH }),
        () =>
          entry(token, target, DAY, { status: 'LEAVE', reason: 'Family matter', baseVersion: 0 }),
        () => tracked(token, target, false),
      ];
      for (const role of ['TEACHER', 'ACCOUNTANT', 'GUARDIAN'] as const) {
        const { token } = await login(s.tenantId, [role]);
        for (const call of calls(token)) await call().expect(403);
      }
      const off = (await createTenant(h)).id;
      const offAdmin = await login(off, ['OWNER']);
      for (const call of calls(offAdmin.token)) await call().expect(403);
      expect(await staffDay(s.tenantId, target)).toBeUndefined();
    });

    it("an institute never sees or changes another's staff days", async () => {
      const a = await setup();
      const b = await setup();
      const theirs = await person(b, { name: 'Their Teacher' });
      await entry(b.me.token, theirs, '2026-10-20', {
        status: 'LEAVE',
        reason: 'Their own leave',
        baseVersion: 0,
      }).expect(200);
      expect(
        (
          await entry(a.me.token, theirs, '2026-10-20', {
            status: 'PRESENT',
            inAt: '09:00',
            reason: 'Not ours',
            baseVersion: 1,
          }).expect(422)
        ).body,
      ).toMatchObject({ code: 'NOT_STAFF' });
      expect((await dayView(a.me.token, '2026-10-20')).people.map((p) => p.userId)).not.toContain(
        theirs,
      );
      expect((await month(a.me.token)).people.map((p) => p.userId)).not.toContain(theirs);
      for (const kind of ['grid', 'days']) {
        const text = await csv(a.me.token, { locale: 'en', kind });
        expect(text).not.toContain('Their');
      }
      expect(await staffDay(b.tenantId, theirs, '2026-10-20')).toMatchObject({
        status: 'LEAVE',
        version: 1,
      });
    });
  });
});

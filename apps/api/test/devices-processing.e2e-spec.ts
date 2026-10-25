import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { withTenant } from '@jantrik/db';
import {
  addDays,
  dateFromDb,
  dateToDb,
  entrySmsText,
  exitSmsText,
  isoWeekday,
} from '@jantrik/shared';
import type { Job, Queue } from 'bullmq';
import { AbsentSmsService } from '../src/attendance/absent-sms.service.js';
import {
  AttendanceSettingsService,
  timeFromDb,
  timeToDb,
} from '../src/attendance/attendance-settings.service.js';
import { RequestContext } from '../src/common/request-context.js';
import {
  DEVICES_TENANTS_KEY,
  DEVICES_TICK_JOB,
  EXPIRE_PUNCHES_JOB,
  processPunchesJobId,
} from '../src/devices/devices.constants.js';
import { DevicesProcessor } from '../src/devices/devices.processor.js';
import { PunchProcessingService } from '../src/devices/punch-processing.service.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import { FakeClock } from './support/clock.js';
import { createHarness, createStudent, createTenant, type Harness } from './support/harness.js';
import { createIngestHarness, type IngestHarness } from './support/ingest.js';
import { dhaka, punchFixtures } from './support/punches.js';

// The devices worker turns raw punches into attendance in each institute's own context: outcomes,
// entry and exit SMS, late punches on DEVICE registers, staff days and the minute sweep. Punches
// come through the receiver (@jantrik/device-sim); both apps share one FakeClock. 2026-10-21 is a
// Wednesday.

const DAY = '2026-10-21';
const at = (time: string, day = DAY) => dhaka(day, time);
const INSTITUTE = 'Test Institute';

describe('punch processing', () => {
  const clock = new FakeClock(at('08:00:00'));
  let h: Harness;
  let ingest: IngestHarness;
  let processor: DevicesProcessor;
  const f = punchFixtures(
    () => h,
    () => ingest,
    clock,
  );

  beforeAll(async () => {
    h = await createHarness({ clock });
    ingest = await createIngestHarness({ clock });
    processor = h.app.get(DevicesProcessor);
  });
  afterAll(async () => {
    await ingest.queue.obliterate({ force: true });
    await ingest.close();
    await h.close();
  });
  beforeEach(() => clock.set(at('08:00:00')));
  afterEach(() => vi.restoreAllMocks());

  const waitForSms = (tenantId: string, status: string, n: number) =>
    vi.waitFor(
      async () => {
        const rows = (await f.smsLogs(tenantId)).filter((r) => r.status === status);
        if (rows.length < n) throw new Error('not yet');
      },
      { timeout: 5_000, interval: 50 },
    );

  it("the receiver's job carries only the institute's id and processes that institute only", async () => {
    const a = await f.institute();
    const b = await f.institute();
    for (const t of [a, b])
      await f.map(t.tenantId, [{ deviceUserId: '101', studentId: t.a[0]!.id }]);
    clock.set(at('07:51:00'));
    await f.upload(f.sim(a.device.serialNo), DAY, [['101', '07:50:00']]);
    await f.holdJob(a.tenantId);
    await f.upload(f.sim(b.device.serialNo), DAY, [['101', '07:50:00']]);
    const job = await ingest.queue.getJob(processPunchesJobId(b.tenantId));
    expect(job?.data).toStrictEqual({ tenantId: b.tenantId });

    await f.settled(b.tenantId);
    expect((await f.punches(b.tenantId)).map((p) => [p.outcome, p.processedAt])).toEqual([
      ['APPLIED', at('07:51:00')],
    ]);
    // A's punch waits for its own job (or the sweep): B's run never touched it.
    expect((await f.punches(a.tenantId)).map((p) => [p.outcome, p.processedAt])).toEqual([
      [null, null],
    ]);
    await processor.drain(a.tenantId);
    expect((await f.punches(a.tenantId)).map((p) => p.outcome)).toEqual(['APPLIED']);
  });

  it('every outcome: STALE, IGNORED (rejected or not active), HELD, UNMAPPED, APPLIED', async () => {
    // Registered 9 days ago, so it may send an 8-day-old punch (STALE). At most 10 punches a
    // minute: the 11th of 07:30 is held (BURST).
    const s = await f.institute(
      { deviceMaxPunchesPerMinute: 10 },
      { registeredAgoMs: 9 * 86_400_000 },
    );
    const teacher = await f.staff(s.tenantId, ['TEACHER']);
    const owner = await f.staff(s.tenantId, ['OWNER']);
    const trackedOwner = await f.staff(s.tenantId, ['OWNER'], true);
    const untracked = await f.staff(s.tenantId, ['TEACHER'], false);
    const disabled = await f.staff(s.tenantId, ['TEACHER']);
    const unenrolled = await createStudent(h, s.tenantId, `S-${randomUUID().slice(0, 8)}`);
    await f.inTenant(s.tenantId, async (tx) => {
      await tx.membership.updateMany({ where: { userId: disabled }, data: { status: 'DISABLED' } });
      await tx.student.update({ where: { id: s.a[1]!.id }, data: { status: 'INACTIVE' } });
      await tx.student.update({ where: { id: s.a[2]!.id }, data: { deletedAt: at('07:00:00') } });
    });
    await f.map(s.tenantId, [
      { deviceUserId: '101', studentId: s.a[0]!.id },
      { deviceUserId: '102', studentId: s.a[1]!.id },
      { deviceUserId: '103', studentId: s.a[2]!.id },
      { deviceUserId: '104', studentId: unenrolled.id },
      { deviceUserId: '9001', staffUserId: teacher },
      { deviceUserId: '9002', staffUserId: owner },
      { deviceUserId: '9003', staffUserId: trackedOwner },
      { deviceUserId: '9004', staffUserId: untracked },
      { deviceUserId: '9005', staffUserId: disabled },
    ]);
    const reader = f.sim(s.device.serialNo);
    const today: [string, string][] = [
      ...Array.from({ length: 10 }, (_, i) => [String(600 + i), `07:30:0${i}`] as [string, string]),
      ['101', '07:30:30'],
      ['101', '07:50:00'],
      ['102', '07:51:00'],
      ['103', '07:52:00'],
      ['104', '07:53:00'],
      ['9001', '07:54:00'],
      ['9001', '07:55:00'],
      ['9002', '07:56:00'],
      ['9003', '07:57:00'],
      ['9004', '07:58:00'],
      ['9005', '07:59:00'],
    ];
    // One upload, so one job (taken away before it runs).
    const res = await reader.uploadAttlog([
      reader.attlogLine('101', at('07:40:00', addDays(DAY, -8))),
      ...today.map(([pin, time]) => reader.attlogLine(pin, at(time))),
    ]);
    expect(res.status).toBe(200);
    await f.holdJob(s.tenantId);
    // Rejected before it was processed: it never counts.
    const rejected = await f.punchOf(s.tenantId, '9001', at('07:55:00'));
    await f.review(s.admin, rejected.id, 'REJECT').expect(200);

    clock.set(at('08:01:00'));
    await processor.drain(s.tenantId);
    const punches = await f.punches(s.tenantId);
    expect(punches.map((p) => [p.deviceUserId, p.outcome])).toEqual([
      ['101', 'STALE'],
      ...Array.from({ length: 10 }, (_, i) => [String(600 + i), 'UNMAPPED']),
      ['101', 'HELD'],
      ['101', 'APPLIED'],
      ['102', 'IGNORED'], // INACTIVE
      ['103', 'IGNORED'], // deleted
      ['104', 'IGNORED'], // not enrolled this year
      ['9001', 'APPLIED'],
      ['9001', 'IGNORED'], // rejected
      ['9002', 'IGNORED'], // only an owner: not tracked
      ['9003', 'APPLIED'], // an owner switched on
      ['9004', 'IGNORED'], // switched off
      ['9005', 'IGNORED'], // membership disabled
    ]);
    expect(punches.every((p) => p.processedAt?.getTime() === at('08:01:00').getTime())).toBe(true);
    expect(punches[11]!.flags).toContain('BURST');
    expect((await f.staffDays(s.tenantId)).map((d) => d.userId).sort()).toEqual(
      [teacher, trackedOwner].sort(),
    );
  });

  describe('entry and exit SMS', () => {
    it('entry: the first IN of the day only, once; a re-sent batch adds nothing; the cost is logged when sent', async () => {
      const s = await f.institute({ entrySmsEnabled: true });
      await f.map(s.tenantId, [
        { deviceUserId: '101', studentId: s.a[0]!.id },
        { deviceUserId: '102', studentId: s.a[1]!.id },
      ]);
      const reader = f.sim(s.device.serialNo);
      const batch: [string, string][] = [
        ['101', '07:50:00'],
        ['102', '07:52:00'],
        ['101', '07:55:00'],
      ];
      clock.set(at('07:56:00'));
      await f.upload(reader, DAY, batch);
      await f.settled(s.tenantId);

      const logs = await f.smsLogs(s.tenantId);
      expect(logs).toHaveLength(2);
      const [first, second] = [0, 1].map((i) => logs.find((l) => l.relatedId === s.a[i]!.id)!);
      expect(first).toMatchObject({
        purpose: 'ATTENDANCE_ENTRY',
        phone: s.a[0]!.phone,
        body: entrySmsText({ student: 'ছাত্র 1', at: at('07:50:00'), institute: INSTITUTE }),
        localDate: dateToDb(DAY),
        dedupeKey: `entry:${s.a[0]!.id}:${DAY}`,
        relatedEntity: 'student',
      });
      expect(second).toMatchObject({
        purpose: 'ATTENDANCE_ENTRY',
        body: entrySmsText({ student: 'ছাত্র 2', at: at('07:52:00'), institute: INSTITUTE }),
        dedupeKey: `entry:${s.a[1]!.id}:${DAY}`,
      });
      await waitForSms(s.tenantId, 'SENT', 2);
      for (const log of await f.smsLogs(s.tenantId)) expect(log.costPaisa).toBeGreaterThan(0);
      expect(h.sms.sentTo(s.a[0]!.phone)).toEqual([first!.body]);

      // The same batch again (a device retrying): nothing stored, nothing sent.
      clock.set(at('07:57:00'));
      await f.upload(reader, DAY, batch);
      // A later IN that day sends nothing either.
      clock.set(at('09:01:00'));
      await f.upload(reader, DAY, [['101', '09:00:00']]);
      await f.settled(s.tenantId);
      expect((await f.punches(s.tenantId)).map((p) => p.outcome)).toEqual([
        'APPLIED',
        'APPLIED',
        'APPLIED',
        'APPLIED',
      ]);
      expect(await f.smsLogs(s.tenantId)).toHaveLength(2);
      await new Promise((r) => setTimeout(r, 300));
      expect(h.sms.sentTo(s.a[0]!.phone)).toHaveLength(1);
    });

    it('exit: the first OUT after the IN, once; an OUT before any IN sends nothing', async () => {
      const s = await f.institute({ exitSmsEnabled: true });
      await f.map(s.tenantId, [{ deviceUserId: '101', studentId: s.a[0]!.id }]);
      const reader = f.sim(s.device.serialNo);
      const step = async (now: string, punches: [string, string, boolean?][]) => {
        clock.set(at(now));
        await f.upload(reader, DAY, punches);
        await f.settled(s.tenantId);
      };
      await step('07:01:00', [['101', '07:00:00', true]]);
      await step('07:51:00', [['101', '07:50:00']]); // entry SMS are off
      expect(await f.smsLogs(s.tenantId)).toEqual([]);
      await step('13:01:00', [
        ['101', '13:00:00', true],
        ['101', '13:00:30', true],
      ]);
      await step('14:01:00', [['101', '14:00:00', true]]);
      expect((await f.punches(s.tenantId)).map((p) => [p.direction, p.outcome])).toEqual([
        ['OUT', 'APPLIED'],
        ['IN', 'APPLIED'],
        ['OUT', 'APPLIED'],
        ['OUT', 'APPLIED'],
        ['OUT', 'APPLIED'],
      ]);
      expect((await f.smsLogs(s.tenantId)).map((l) => [l.purpose, l.dedupeKey, l.body])).toEqual([
        [
          'ATTENDANCE_EXIT',
          `exit:${s.a[0]!.id}:${DAY}`,
          exitSmsText({ student: 'ছাত্র 1', at: at('13:00:00'), institute: INSTITUTE }),
        ],
      ]);
    });

    it('none for a punch from a new address, outside the hours or uploaded late; they still apply', async () => {
      clock.set(at('04:00:00'));
      const s = await f.institute({ entrySmsEnabled: true });
      await f.map(
        s.tenantId,
        s.a.map((st, i) => ({ deviceUserId: String(101 + i), studentId: st.id })),
      );
      const home = f.sim(s.device.serialNo);
      // Before 05:00 (OUTSIDE_HOURS), from the device's first address (trusted).
      clock.set(at('04:31:00'));
      await f.upload(home, DAY, [['102', '04:30:00']]);
      await f.settled(s.tenantId);
      // Another address: NEW_IP.
      clock.set(at('07:51:00'));
      await f.upload(f.sim(s.device.serialNo), DAY, [['101', '07:50:00']]);
      await f.settled(s.tenantId);
      // Received 15 minutes after it was made: a backlog.
      clock.set(at('08:15:00'));
      await f.upload(home, DAY, [['103', '08:00:00']]);
      await f.settled(s.tenantId);
      expect(
        (await f.punches(s.tenantId)).map((p) => [p.deviceUserId, p.flags, p.outcome]),
      ).toEqual([
        ['102', ['OUTSIDE_HOURS'], 'APPLIED'],
        ['101', ['NEW_IP'], 'APPLIED'],
        ['103', [], 'APPLIED'],
      ]);
      expect(await f.smsLogs(s.tenantId)).toEqual([]);
    });

    it('none on an off day or when turned off', async () => {
      const off = await f.institute({ entrySmsEnabled: true, weeklyOffDays: [isoWeekday(DAY)] });
      const disabled = await f.institute({ entrySmsEnabled: false, exitSmsEnabled: true });
      for (const s of [off, disabled]) {
        await f.map(s.tenantId, [{ deviceUserId: '101', studentId: s.a[0]!.id }]);
        clock.set(at('07:51:00'));
        await f.upload(f.sim(s.device.serialNo), DAY, [['101', '07:50:00']]);
        await f.settled(s.tenantId);
        expect((await f.punches(s.tenantId)).map((p) => p.outcome)).toEqual(['APPLIED']);
        expect(await f.smsLogs(s.tenantId)).toEqual([]);
      }
    });

    it("stop once the day's SMS reach 90 % of the cap, leaving no sms_logs row", async () => {
      const s = await f.institute({ entrySmsEnabled: true, dailySmsCap: 3 }); // 90 %: 2
      await f.map(
        s.tenantId,
        s.a.map((st, i) => ({ deviceUserId: String(101 + i), studentId: st.id })),
      );
      clock.set(at('07:56:00'));
      await f.upload(f.sim(s.device.serialNo), DAY, [
        ['101', '07:50:00'],
        ['102', '07:51:00'],
        ['103', '07:52:00'],
      ]);
      await f.settled(s.tenantId);
      const logs = await f.smsLogs(s.tenantId);
      expect(logs.map((l) => l.relatedId).sort()).toEqual([s.a[0]!.id, s.a[1]!.id].sort());
      expect(logs.some((l) => l.status === 'HELD_OVER_LIMIT')).toBe(false);
    });

    it('PER_SESSION, or auto-mark off: the entry SMS goes, the register stays as it is', async () => {
      const perSession = await f.institute({
        mode: 'PER_SESSION',
        entrySmsEnabled: true,
        deviceAutoMark: true,
      });
      const manualMode = await f.institute({ entrySmsEnabled: true, deviceAutoMark: false });
      for (const s of [perSession, manualMode]) {
        const sessionId = await f.deviceRegister(s, DAY, [
          { status: 'ABSENT' },
          { status: 'ABSENT' },
          { status: 'ABSENT' },
        ]);
        await f.map(s.tenantId, [{ deviceUserId: '101', studentId: s.a[0]!.id }]);
        clock.set(at('07:51:00'));
        await f.upload(f.sim(s.device.serialNo), DAY, [['101', '07:50:00']]);
        await f.settled(s.tenantId);
        expect((await f.smsLogs(s.tenantId)).map((l) => l.purpose)).toEqual(['ATTENDANCE_ENTRY']);
        expect(await f.register(s.tenantId, sessionId)).toMatchObject({ version: 1 });
        expect(await f.statusOf(s.tenantId, sessionId, s.a[0]!.id)).toBe('ABSENT');
      }
    });
  });

  describe('a DEVICE register for today', () => {
    it('a later punch turns ABSENT into LATE (version, audit, still DEVICE) and the pending absent SMS ends CANCELLED; MANUAL records stay', async () => {
      const s = await f.institute({ deviceAutoMark: true, absentSmsDelayMinutes: 10 });
      // Written at the cutoff: student 1 absent, 2 present, 3 absent as a teacher set it.
      clock.set(at('09:00:00'));
      const sessionId = await f.deviceRegister(s, DAY, [
        { status: 'ABSENT' },
        { status: 'PRESENT' },
        { status: 'ABSENT', source: 'MANUAL' },
      ]);
      // The cutoff's absent SMS for student 1, waiting out its 10-minute delay.
      await h.app
        .get(TenantJobRunner)
        .run(s.tenantId, async () =>
          h.app
            .get(AbsentSmsService)
            .queue(await h.app.get(AttendanceSettingsService).load(), DAY, [s.a[0]!.id]),
        );
      const [absentSms] = await f.smsLogs(s.tenantId);
      expect(absentSms).toMatchObject({ purpose: 'ATTENDANCE_ABSENT', status: 'QUEUED' });

      await f.map(s.tenantId, [
        { deviceUserId: '101', studentId: s.a[0]!.id },
        { deviceUserId: '103', studentId: s.a[2]!.id },
      ]);
      clock.set(at('09:21:00'));
      await f.upload(f.sim(s.device.serialNo), DAY, [
        ['101', '09:20:00'],
        ['103', '09:20:30'],
      ]);
      await f.settled(s.tenantId);

      const after = await f.register(s.tenantId, sessionId);
      expect(after).toMatchObject({
        version: 2,
        source: 'DEVICE',
        updatedById: null,
        submittedAt: at('09:21:00'),
      });
      expect(
        Object.fromEntries(after.records.map((r) => [r.studentId, [r.status, r.source]])),
      ).toEqual({
        [s.a[0]!.id]: ['LATE', 'DEVICE'],
        [s.a[1]!.id]: ['PRESENT', 'DEVICE'],
        [s.a[2]!.id]: ['ABSENT', 'MANUAL'],
      });
      expect(await f.audits(s.tenantId, 'attendance_session', sessionId)).toEqual([
        {
          action: 'UPDATE',
          actorUserId: null,
          oldValues: { [s.a[0]!.id]: 'ABSENT' },
          newValues: { [s.a[0]!.id]: 'LATE', source: 'DEVICE' },
        },
      ]);

      // Run the delayed SMS now: the student is no longer absent.
      const smsQueue = h.app.get<Queue>(getQueueToken('sms'));
      await (await smsQueue.getJob(absentSms!.id))!.promote();
      await waitForSms(s.tenantId, 'CANCELLED', 1);
      expect(h.sms.sentTo(s.a[0]!.phone)).toEqual([]);
    });
  });

  describe('staff days', () => {
    it('in, out, late and early by the office hours of the day, kept on the row; a later punch rebuilds it', async () => {
      const s = await f.institute({ staffOfficeStart: '09:00', staffOfficeEnd: '17:00' });
      const teacher = await f.staff(s.tenantId, ['TEACHER']);
      await f.map(s.tenantId, [{ deviceUserId: '9001', staffUserId: teacher }]);
      const reader = f.sim(s.device.serialNo);
      const step = async (now: string, punches: [string, string, boolean?][]) => {
        clock.set(at(now));
        await f.upload(reader, DAY, punches);
        await f.settled(s.tenantId);
        const days = await f.staffDays(s.tenantId);
        expect(days).toHaveLength(1);
        const d = days[0]!;
        return {
          userId: d.userId,
          status: d.status,
          source: d.source,
          inAt: d.inAt,
          outAt: d.outAt,
          lateMinutes: d.lateMinutes,
          earlyMinutes: d.earlyMinutes,
          officeStart: timeFromDb(d.officeStart),
          officeEnd: timeFromDb(d.officeEnd),
          reason: d.reason,
          updatedById: d.updatedById,
          version: d.version,
        };
      };
      expect(await step('09:16:00', [['9001', '09:15:00']])).toEqual({
        userId: teacher,
        status: 'PRESENT',
        source: 'DEVICE',
        inAt: at('09:15:00'),
        outAt: null,
        lateMinutes: 15,
        earlyMinutes: 0,
        officeStart: '09:00',
        officeEnd: '17:00',
        reason: null,
        updatedById: null,
        version: 1,
      });
      expect(await step('16:01:00', [['9001', '16:00:00', true]])).toMatchObject({
        inAt: at('09:15:00'),
        outAt: at('16:00:00'),
        lateMinutes: 15,
        earlyMinutes: 60,
        version: 2,
      });
      // New office hours judge the next rebuild, and the row keeps the hours it was judged by.
      await f.putSettings(s.admin, { staffOfficeStart: '08:00', staffOfficeEnd: '16:00' });
      expect(await step('16:31:00', [['9001', '16:30:00', true]])).toMatchObject({
        inAt: at('09:15:00'),
        outAt: at('16:30:00'),
        lateMinutes: 75,
        earlyMinutes: 0,
        officeStart: '08:00',
        officeEnd: '16:00',
        version: 3,
      });
    });

    it('a MANUAL day is never changed; an owner is not tracked; punches up to 7 days old rebuild their day', async () => {
      const s = await f.institute({}, { registeredAgoMs: 9 * 86_400_000 });
      const onLeave = await f.staff(s.tenantId, ['TEACHER']);
      const owner = await f.staff(s.tenantId, ['OWNER']);
      const teacher = await f.staff(s.tenantId, ['TEACHER']);
      await f.inTenant(s.tenantId, (tx) =>
        tx.staffAttendanceDay.create({
          data: {
            tenantId: s.tenantId,
            userId: onLeave,
            date: dateToDb(DAY),
            status: 'LEAVE',
            source: 'MANUAL',
            reason: 'Sick leave',
            updatedById: teacher,
            officeStart: timeToDb('08:00'),
            officeEnd: timeToDb('16:00'),
          },
        }),
      );
      await f.map(s.tenantId, [
        { deviceUserId: '9001', staffUserId: onLeave },
        { deviceUserId: '9002', staffUserId: owner },
        { deviceUserId: '9003', staffUserId: teacher },
      ]);
      const reader = f.sim(s.device.serialNo);
      // One upload (a device back online after a week): 8, 7 and 3 days old, and today.
      const res = await reader.uploadAttlog([
        reader.attlogLine('9003', at('09:00:00', addDays(DAY, -8))),
        reader.attlogLine('9003', at('09:00:00', addDays(DAY, -7))),
        reader.attlogLine('9003', at('09:00:00', addDays(DAY, -3))),
        reader.attlogLine('9001', at('07:50:00')),
        reader.attlogLine('9002', at('07:51:00')),
      ]);
      expect(res.status).toBe(200);
      await f.settled(s.tenantId);
      expect((await f.punches(s.tenantId)).map((p) => [p.deviceUserId, p.outcome])).toEqual([
        ['9003', 'STALE'],
        ['9003', 'APPLIED'],
        ['9003', 'APPLIED'],
        ['9001', 'APPLIED'],
        ['9002', 'IGNORED'],
      ]);
      const days = await f.staffDays(s.tenantId);
      expect(
        days.map((d) => [d.userId, dateFromDb(d.date), d.status, d.source, d.version]),
      ).toEqual(
        expect.arrayContaining([
          [onLeave, DAY, 'LEAVE', 'MANUAL', 1],
          [teacher, addDays(DAY, -7), 'PRESENT', 'DEVICE', 1],
          [teacher, addDays(DAY, -3), 'PRESENT', 'DEVICE', 1],
        ]),
      );
      expect(days).toHaveLength(3);
    });
  });

  describe('the minute sweep', () => {
    it('devices-tick processes punches that had no job, for the listed institutes with attendance on; one failing stops none', async () => {
      // The harness removes the scheduler (no real-time ticks in tests): register it again.
      await processor.onModuleInit();
      expect(await ingest.queue.getJobScheduler(DEVICES_TICK_JOB)).toMatchObject({
        name: DEVICES_TICK_JOB,
        pattern: '* * * * *',
        tz: 'Asia/Dhaka',
        template: { opts: { removeOnComplete: true, removeOnFail: 50 } },
      });
      await ingest.queue.removeJobScheduler(DEVICES_TICK_JOB);
      // onModuleInit also registered the retention scheduler (devices-retention tests it).
      await ingest.queue.removeJobScheduler(EXPIRE_PUNCHES_JOB);
      const s = await f.institute();
      const broken = await f.institute();
      for (const t of [s, broken]) {
        await f.map(t.tenantId, [{ deviceUserId: '101', studentId: t.a[0]!.id }]);
        clock.set(at('07:51:00'));
        await f.upload(f.sim(t.device.serialNo), DAY, [['101', '07:50:00']]);
        await f.holdJob(t.tenantId);
      }
      const off = await createTenant(h, { modules: [] });

      // `broken` fails inside its own transaction; the log names the error only.
      const processing = h.app.get(PunchProcessingService);
      const context = h.app.get(RequestContext);
      const real = processing.processBatch.bind(processing);
      vi.spyOn(processing, 'processBatch').mockImplementation(async (limit) => {
        if (context.requireTenantId() === broken.tenantId) throw new Error('a row value');
        return real(limit);
      });
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      clock.set(at('07:52:00'));
      for (const id of [broken.tenantId, off.id, s.tenantId]) {
        await h.redis.zadd(DEVICES_TENANTS_KEY, Date.now(), id);
      }

      await processor.process({ name: DEVICES_TICK_JOB } as unknown as Job);
      expect((await f.punches(s.tenantId)).map((p) => [p.outcome, p.processedAt])).toEqual([
        ['APPLIED', at('07:52:00')],
      ]);
      expect((await f.punches(broken.tenantId)).map((p) => p.processedAt)).toEqual([null]);
      const lines = errors.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain(`Devices tick failed for ${broken.tenantId}: Error`);
      expect(lines.join('\n')).not.toContain('a row value');
    });

    it('a batch waits at most 5 s for a lock, then fails and is left for the next tick', async () => {
      const s = await f.institute();
      await f.map(s.tenantId, [{ deviceUserId: '101', studentId: s.a[0]!.id }]);
      clock.set(at('07:51:00'));
      await f.upload(f.sim(s.device.serialNo), DAY, [['101', '07:50:00']]);
      await f.holdJob(s.tenantId);
      // Another transaction holds the institute's punch lock and keeps it.
      let release!: () => void;
      const kept = new Promise<void>((resolve) => (release = resolve));
      let lockTaken!: () => void;
      const taken = new Promise<void>((resolve) => (lockTaken = resolve));
      const holder = withTenant(
        h.prisma,
        s.tenantId,
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('device-punches:' || app_current_tenant_id()::text, 0))`;
          lockTaken();
          await kept;
        },
        { timeout: 30_000 },
      );
      await taken;
      // Should the wait not be limited, the holder still lets go after 8 s, so the test fails
      // instead of hanging on the lock.
      const failsafe = setTimeout(release, 8_000);
      const started = Date.now();
      await expect(processor.drain(s.tenantId)).rejects.toThrow(/lock timeout/);
      expect(Date.now() - started).toBeLessThan(8_000);
      clearTimeout(failsafe);
      expect((await f.punches(s.tenantId)).map((p) => p.processedAt)).toEqual([null]);
      release();
      await holder;
      await processor.drain(s.tenantId);
      expect((await f.punches(s.tenantId)).map((p) => p.outcome)).toEqual(['APPLIED']);
    });
  });
});

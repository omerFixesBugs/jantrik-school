import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { withTenant } from '@jantrik/db';
import type { ZkDeviceSimulator } from '@jantrik/device-sim';
import {
  dateToDb,
  isoWeekday,
  type AttendanceSettings,
  type AttendanceSheet,
  type AttendanceStatus,
  type AttendanceTodayReport,
  type CloseFromDeviceResult,
  type StudentAttendanceReport,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import { AbsentSmsService } from '../src/attendance/absent-sms.service.js';
import { timeToDb } from '../src/attendance/attendance-settings.service.js';
import { DeviceArrivalsService } from '../src/attendance/device-arrivals.service.js';
import { DevicesProcessor, PUNCH_BATCH } from '../src/devices/devices.processor.js';
import { PunchProcessingService } from '../src/devices/punch-processing.service.js';
import { Db } from '../src/tenancy/db.service.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import { FakeClock } from './support/clock.js';
import { bearer, createHarness, http, randomPhone, type Harness } from './support/harness.js';
import { createIngestHarness, type IngestHarness } from './support/ingest.js';
import { dhaka, punchFixtures, type Institute } from './support/punches.js';

// Registers written from device punches: at each shift's cutoff by the minute tick (with its
// hold-backs), closed from the device by an admin, and what the register API says about the
// device. Punches come through the receiver (@jantrik/device-sim); both apps share one FakeClock.
// 2026-10-21 is a Wednesday. With the defaults a section starts at 08:00, a first IN after 08:10:00
// is LATE, and the register is due at 09:00.

const DAY = '2026-10-21';
const at = (time: string) => dhaka(DAY, time);

type Setup = Institute & { reader: ZkDeviceSimulator };

describe('device registers', () => {
  const clock = new FakeClock(at('07:00:00'));
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
  beforeEach(() => clock.set(at('07:00:00')));
  afterEach(() => vi.restoreAllMocks());

  /** The device confirmed adding these IDs (a USER_UPSERT done), as after "send people". */
  const confirmOnDevice = (s: Institute, ids: string[]) =>
    f.inTenant(s.tenantId, (tx) =>
      tx.deviceCommand.createMany({
        data: ids.map((deviceUserId) => ({
          tenantId: s.tenantId,
          deviceId: s.device.id,
          kind: 'USER_UPSERT' as const,
          deviceUserId,
          payload: `DATA UPDATE USERINFO PIN=${deviceUserId}\tName=Student`,
          status: 'DONE' as const,
          doneAt: at('06:00:00'),
        })),
      }),
    );

  /**
   * A school (section A: 3 students as 101–103, section B: 1 as 201) with auto-mark on, its
   * students on the device (all of them unless `onDevice` says which IDs), and the device seen
   * from one trusted address.
   */
  const setup = async (
    settings: Partial<AttendanceSettings> = {},
    onDevice = ['101', '102', '103', '201'],
  ): Promise<Setup> => {
    const s = await f.institute({ deviceAutoMark: true, ...settings });
    await f.map(s.tenantId, [
      ...s.a.map((st, i) => ({ deviceUserId: String(101 + i), studentId: st.id })),
      { deviceUserId: '201', studentId: s.b[0]!.id },
    ]);
    await confirmOnDevice(s, onDevice);
    return { ...s, reader: f.sim(s.device.serialNo) };
  };

  /** One more student in section A (no device ID), with a primary guardian. */
  const enrol = (s: Institute) =>
    f.inTenant(s.tenantId, async (tx) => {
      const section = await tx.section.findUniqueOrThrow({ where: { id: s.sectionA } });
      const student = await tx.student.create({
        data: {
          tenantId: s.tenantId,
          studentCode: `S-${randomUUID().slice(0, 8)}`,
          nameBn: 'ছাত্র 4',
          nameEn: 'Student 4',
        },
      });
      await tx.enrolment.create({
        data: {
          tenantId: s.tenantId,
          studentId: student.id,
          academicYearId: section.academicYearId,
          classLevelId: section.classLevelId,
          sectionId: s.sectionA,
          roll: 4,
        },
      });
      const phone = randomPhone();
      const guardian = await tx.guardian.create({
        data: { tenantId: s.tenantId, nameEn: 'Parent', phone },
      });
      await tx.studentGuardian.create({
        data: {
          tenantId: s.tenantId,
          studentId: student.id,
          guardianId: guardian.id,
          relation: 'FATHER',
          isPrimary: true,
        },
      });
      return { id: student.id, phone };
    });

  /** Punches of [pin, time] uploaded at `now` and processed. */
  const punch = async (s: Setup, now: string, punches: [string, string][]) => {
    clock.set(at(now));
    await f.upload(s.reader, DAY, punches);
    await f.settled(s.tenantId);
  };

  /** The device calls in at `now`, then the institute's minute tick runs. */
  const tickAt = async (s: Setup, now: string) => {
    clock.set(at(now));
    expect((await s.reader.ping()).status).toBe(200);
    await processor.tick(s.tenantId);
  };

  const registerOf = (s: Setup, sectionId = s.sectionA) =>
    f.inTenant(s.tenantId, (tx) =>
      tx.attendanceSession.findFirst({
        where: { sectionId, date: dateToDb(DAY), periodNo: 0 },
        select: {
          id: true,
          version: true,
          source: true,
          takenById: true,
          updatedById: true,
          submittedAt: true,
          records: { select: { studentId: true, status: true, source: true } },
        },
      }),
    );
  /** [status, source] of each student, in roll order. */
  const rows = async (s: Setup, sectionId = s.sectionA) => {
    const register = await registerOf(s, sectionId);
    const students = sectionId === s.sectionA ? s.a : s.b;
    return students.map((st) => {
      const r = register!.records.find((x) => x.studentId === st.id)!;
      return [r.status, r.source];
    });
  };
  const sessionCount = (tenantId: string) =>
    f.inTenant(tenantId, (tx) => tx.attendanceSession.count());

  const todayReport = async (token: string) =>
    (await http(h).get('/attendance/reports/today').set(bearer(token)).expect(200))
      .body as AttendanceTodayReport;
  const sectionOf = (report: AttendanceTodayReport, sectionId: string) =>
    report.sections.find((x) => x.section.id === sectionId)!;
  const sheet = async (token: string, sectionId: string) =>
    (
      await http(h)
        .get('/attendance/sessions')
        .query({ sectionId, date: DAY })
        .set(bearer(token))
        .expect(200)
    ).body as AttendanceSheet;
  const submit = (token: string, s: Setup, baseVersion: number, statuses: AttendanceStatus[]) =>
    http(h)
      .put('/attendance/sessions')
      .set(bearer(token))
      .send({
        sectionId: s.sectionA,
        date: DAY,
        baseVersion,
        submissionId: randomUUID(),
        records: s.a.map((st, i) => ({ studentId: st.id, status: statuses[i] })),
      });
  const close = (token: string, sectionId: string) =>
    http(h).post(`/attendance/sections/${sectionId}/close-from-device`).set(bearer(token));

  const absentSms = async (tenantId: string) =>
    (await f.smsLogs(tenantId))
      .filter((l) => l.purpose === 'ATTENDANCE_ABSENT')
      .map((l) => [l.relatedId, l.dedupeKey]);
  const waitForSms = (tenantId: string, status: string, n: number) =>
    vi.waitFor(
      async () => {
        const rows = (await f.smsLogs(tenantId)).filter((r) => r.status === status);
        if (rows.length < n) throw new Error('not yet');
      },
      { timeout: 5_000, interval: 50 },
    );
  const userWithRole = (tenantId: string, role: 'ADMIN' | 'TEACHER', sectionId?: string) =>
    f.inTenant(tenantId, async (tx) =>
      sectionId
        ? (await tx.sectionTeacher.findFirstOrThrow({ where: { sectionId } })).userId
        : (await tx.membership.findFirstOrThrow({ where: { role } })).userId,
    );

  describe('the cutoff', () => {
    it('writes the register at the cutoff: PRESENT up to start + grace, LATE a second after, ABSENT without a punch; audited; one absent SMS', async () => {
      const s = await setup();
      await punch(s, '08:10:30', [
        ['101', '08:10:00'],
        ['102', '08:10:01'],
        ['201', '08:05:00'],
      ]);

      // A second before the cutoff: nothing yet, the today report counts live.
      await tickAt(s, '08:59:59');
      expect(await registerOf(s)).toBeNull();
      const before = sectionOf(await todayReport(s.admin), s.sectionA);
      expect(before.device).toEqual({
        arrived: 2,
        late: 1,
        enrolled: 3,
        notOnDevice: 0,
        cutoffAt: '09:00',
        state: 'BEFORE_CUTOFF',
      });
      expect(before.register).toBeNull();

      await tickAt(s, '09:00:00');
      const register = await registerOf(s);
      expect(register).toMatchObject({
        version: 1,
        source: 'DEVICE',
        takenById: null,
        updatedById: null,
        submittedAt: at('09:00:00'),
      });
      expect(await rows(s)).toEqual([
        ['PRESENT', 'DEVICE'],
        ['LATE', 'DEVICE'],
        ['ABSENT', 'DEVICE'],
      ]);
      expect(await rows(s, s.sectionB)).toEqual([['PRESENT', 'DEVICE']]);
      expect(await f.audits(s.tenantId, 'attendance_session', register!.id)).toEqual([
        {
          action: 'CREATE',
          actorUserId: null,
          oldValues: null,
          newValues: {
            sectionId: s.sectionA,
            date: DAY,
            periodNo: 0,
            source: 'DEVICE',
            records: { [s.a[0]!.id]: 'PRESENT', [s.a[1]!.id]: 'LATE', [s.a[2]!.id]: 'ABSENT' },
          },
        },
      ]);
      await waitForSms(s.tenantId, 'SENT', 1);

      // Later ticks write nothing more and send nothing more.
      await tickAt(s, '09:05:00');
      expect((await registerOf(s))!.version).toBe(1);
      expect(await sessionCount(s.tenantId)).toBe(2);
      expect(await absentSms(s.tenantId)).toEqual([[s.a[2]!.id, `absent:${s.a[2]!.id}:${DAY}`]]);
      expect(h.sms.sentTo(s.a[2]!.phone)).toHaveLength(1);
      const after = sectionOf(await todayReport(s.admin), s.sectionA);
      expect(after.device).toMatchObject({ arrived: 2, late: 1, state: 'CLOSED' });
      expect(after.register).toMatchObject({
        source: 'DEVICE',
        updatedByDevice: true,
        updatedBy: { id: '', name: '' },
        counts: { present: 1, late: 1, absent: 1, leave: 0 },
      });
    });

    it('each shift closes at its own cutoff: the morning shift closes while the day shift waits', async () => {
      const s = await setup();
      await f.inTenant(s.tenantId, async (tx) => {
        const shift = (name: string, start: string, end: string) =>
          tx.shift.create({
            data: {
              tenantId: s.tenantId,
              nameBn: name,
              nameEn: name,
              startTime: timeToDb(start),
              endTime: timeToDb(end),
            },
            select: { id: true },
          });
        const morning = await shift('Morning', '07:00', '12:00');
        const day = await shift('Day', '12:00', '17:00');
        await tx.section.update({ where: { id: s.sectionA }, data: { shiftId: morning.id } });
        await tx.section.update({ where: { id: s.sectionB }, data: { shiftId: day.id } });
      });
      await punch(s, '07:10:30', [
        ['101', '07:05:00'],
        ['102', '07:10:00'],
      ]);

      await tickAt(s, '08:00:00');
      expect(await rows(s)).toEqual([
        ['PRESENT', 'DEVICE'],
        ['PRESENT', 'DEVICE'],
        ['ABSENT', 'DEVICE'],
      ]);
      expect(await registerOf(s, s.sectionB)).toBeNull();
      const report = await todayReport(s.admin);
      expect(sectionOf(report, s.sectionA).device).toMatchObject({
        cutoffAt: '08:00',
        state: 'CLOSED',
      });
      expect(sectionOf(report, s.sectionB).device).toEqual({
        arrived: 0,
        late: 0,
        enrolled: 1,
        notOnDevice: 0,
        cutoffAt: '13:00',
        state: 'BEFORE_CUTOFF',
      });

      // The day shift starts at 12:00: 12:11 is late.
      await punch(s, '12:11:30', [['201', '12:11:00']]);
      await tickAt(s, '12:59:59');
      expect(await registerOf(s, s.sectionB)).toBeNull();
      await tickAt(s, '13:00:00');
      expect(await rows(s, s.sectionB)).toEqual([['LATE', 'DEVICE']]);
    });

    it('a punch after the cutoff turns ABSENT into LATE and the pending absent SMS ends CANCELLED; later ticks send none', async () => {
      const s = await setup({ absentSmsDelayMinutes: 10 });
      await punch(s, '07:51:00', [
        ['101', '07:50:00'],
        ['102', '07:50:30'],
      ]);
      await tickAt(s, '09:00:00');
      expect((await rows(s))[2]).toEqual(['ABSENT', 'DEVICE']);
      const [pending] = await f.smsLogs(s.tenantId);
      expect(pending).toMatchObject({
        purpose: 'ATTENDANCE_ABSENT',
        relatedId: s.a[2]!.id,
        status: 'QUEUED',
      });

      await punch(s, '09:21:00', [['103', '09:20:00']]);
      expect((await rows(s))[2]).toEqual(['LATE', 'DEVICE']);
      // Run the delayed SMS now: the student is no longer absent.
      const smsQueue = h.app.get<Queue>(getQueueToken('sms'));
      await (await smsQueue.getJob(pending!.id))!.promote();
      await waitForSms(s.tenantId, 'CANCELLED', 1);

      await tickAt(s, '09:30:00');
      expect(await f.smsLogs(s.tenantId)).toHaveLength(1);
      expect(h.sms.sentTo(s.a[2]!.phone)).toEqual([]);
    });

    it("a teacher's register submitted before the cutoff is left as it is", async () => {
      const s = await setup();
      await punch(s, '07:51:00', [
        ['101', '07:50:00'],
        ['201', '07:50:30'],
      ]);
      clock.set(at('08:30:00'));
      await submit(s.teacher, s, 0, ['PRESENT', 'PRESENT', 'ABSENT']).expect(200);

      await tickAt(s, '09:00:00');
      expect(await registerOf(s)).toMatchObject({ version: 1, source: 'MANUAL' });
      expect(await rows(s)).toEqual([
        ['PRESENT', 'MANUAL'],
        ['PRESENT', 'MANUAL'],
        ['ABSENT', 'MANUAL'],
      ]);
      expect(await rows(s, s.sectionB)).toEqual([['PRESENT', 'DEVICE']]);
      expect(await absentSms(s.tenantId)).toEqual([[s.a[2]!.id, `absent:${s.a[2]!.id}:${DAY}`]]);
    });

    it("a teacher's submit racing the cutoff: one register, the teacher's, and no error", async () => {
      const s = await setup();
      await punch(s, '07:51:00', [
        ['101', '07:50:00'],
        ['102', '07:50:30'],
        ['103', '07:51:00'],
        ['201', '07:50:00'],
      ]);
      // The teacher's submit commits after the cutoff found A without a register, before it
      // writes one.
      const arrivals = h.app.get(DeviceArrivalsService);
      const real = arrivals.sectionDays.bind(arrivals);
      let raced = false;
      vi.spyOn(arrivals, 'sectionDays').mockImplementation(async (...args) => {
        if (!raced && args[0].includes(s.sectionA)) {
          raced = true;
          await submit(s.teacher, s, 0, ['PRESENT', 'ABSENT', 'PRESENT']).expect(200);
        }
        return real(...args);
      });

      await tickAt(s, '09:00:00');
      expect(raced).toBe(true);
      expect(await registerOf(s)).toMatchObject({ version: 1, source: 'MANUAL' });
      expect(await rows(s)).toEqual([
        ['PRESENT', 'MANUAL'],
        ['ABSENT', 'MANUAL'],
        ['PRESENT', 'MANUAL'],
      ]);
      expect(await rows(s, s.sectionB)).toEqual([['PRESENT', 'DEVICE']]);
      expect(await sessionCount(s.tenantId)).toBe(2);
    });

    it("the cutoff's register first, a teacher's submit waiting on it: 409 with the device's register", async () => {
      const s = await setup();
      await punch(s, '07:51:00', [
        ['101', '07:50:00'],
        ['102', '07:50:30'],
        ['201', '07:50:00'],
      ]);
      // A's register is inserted, not committed yet: the teacher's submit starts and waits on it.
      const absentSms = h.app.get(AbsentSmsService);
      const real = absentSms.queue.bind(absentSms);
      let teacher: Promise<{ status: number; body: Record<string, unknown> }> | null = null;
      vi.spyOn(absentSms, 'queue').mockImplementation(async (tenant, date, ids) => {
        if (!teacher && ids.includes(s.a[2]!.id)) {
          teacher = submit(s.teacher, s, 0, ['PRESENT', 'PRESENT', 'PRESENT']).then((r) => r);
          await vi.waitFor(
            async () => {
              // A backend of this database waiting on another transaction (the insert's key).
              const [w] = await h.prisma.$queryRaw<{ n: number }[]>`
                SELECT count(*)::int AS n
                FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
                WHERE NOT l.granted AND l.locktype = 'transactionid'
                  AND a.datname = current_database()`;
              if (w!.n === 0) throw new Error('the submit is not waiting yet');
            },
            { timeout: 5_000, interval: 25 },
          );
        }
        return real(tenant, date, ids);
      });

      await tickAt(s, '09:00:00');
      expect(teacher).not.toBeNull();
      const res = await teacher!;
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'VERSION_CONFLICT',
        session: { version: 1, source: 'DEVICE', updatedByDevice: true },
      });
      expect(await rows(s)).toEqual([
        ['PRESENT', 'DEVICE'],
        ['PRESENT', 'DEVICE'],
        ['ABSENT', 'DEVICE'],
      ]);
    });

    it('one section per transaction: a section that fails is logged by the error name and the others still close', async () => {
      const s = await setup();
      await punch(s, '07:51:00', [
        ['101', '07:50:00'],
        ['102', '07:50:30'],
        ['201', '07:50:00'],
      ]);
      const arrivals = h.app.get(DeviceArrivalsService);
      const real = arrivals.sectionDays.bind(arrivals);
      vi.spyOn(arrivals, 'sectionDays').mockImplementation(async (...args) => {
        if (args[0].includes(s.sectionA)) throw new Error('a row value');
        return real(...args);
      });
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await tickAt(s, '09:00:00');
      expect(await registerOf(s)).toBeNull();
      expect(await rows(s, s.sectionB)).toEqual([['PRESENT', 'DEVICE']]);
      const lines = errors.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.startsWith('Cutoff failed'))).toEqual([
        `Cutoff failed for ${s.tenantId}, section ${s.sectionA}: Error`,
      ]);
      expect(lines.join('\n')).not.toContain('a row value');

      // The next minute A closes.
      vi.restoreAllMocks();
      await tickAt(s, '09:01:00');
      expect((await registerOf(s))?.source).toBe('DEVICE');
    });

    it('a device seen 14:59 before the cutoff counts; 15:01 before, it is offline', async () => {
      const seen = await setup();
      const gone = await setup();
      for (const s of [seen, gone]) {
        await punch(s, '07:51:00', [
          ['101', '07:50:00'],
          ['102', '07:50:30'],
          ['201', '07:50:00'],
        ]);
      }
      clock.set(at('08:45:01'));
      expect((await seen.reader.ping()).status).toBe(200);
      clock.set(at('08:44:59'));
      expect((await gone.reader.ping()).status).toBe(200);

      clock.set(at('09:00:00'));
      for (const s of [seen, gone]) await processor.tick(s.tenantId);
      expect(await sessionCount(seen.tenantId)).toBe(2);
      expect(await sessionCount(gone.tenantId)).toBe(0);
      expect(sectionOf(await todayReport(gone.admin), gone.sectionA).device).toMatchObject({
        state: 'DEVICE_OFFLINE',
      });
    });

    it("institute B's tick never touches institute A", async () => {
      const a = await setup();
      const b = await setup();
      for (const s of [a, b]) {
        await punch(s, '07:51:00', [
          ['101', '07:50:00'],
          ['102', '07:50:30'],
          ['201', '07:50:00'],
        ]);
      }
      clock.set(at('09:00:00'));
      expect((await a.reader.ping()).status).toBe(200);
      await tickAt(b, '09:00:00');
      expect(await sessionCount(b.tenantId)).toBe(2);
      expect(await sessionCount(a.tenantId)).toBe(0);
      await processor.tick(a.tenantId);
      expect(await sessionCount(a.tenantId)).toBe(2);
    });

    it('nothing on an off day, in PER_SESSION mode or with auto-mark off; the take screen still shows arrivals', async () => {
      const off = await setup({ weeklyOffDays: [isoWeekday(DAY)] });
      const perSession = await setup({ mode: 'PER_SESSION' });
      const manual = await setup({ deviceAutoMark: false });
      for (const s of [off, perSession, manual]) {
        await punch(s, '07:51:00', [
          ['101', '07:50:00'],
          ['102', '07:50:30'],
          ['103', '07:51:00'],
          ['201', '07:50:00'],
        ]);
        await tickAt(s, '09:00:00');
        expect(await sessionCount(s.tenantId)).toBe(0);
        expect((await todayReport(s.admin)).sections.map((x) => x.device)).toEqual([null, null]);
      }
      expect((await close(off.admin, off.sectionA).expect(422)).body.code).toBe('NON_WORKING_DAY');
      expect((await close(perSession.admin, perSession.sectionA).expect(422)).body.code).toBe(
        'WRONG_PERIOD_FOR_MODE',
      );
      const taking = await sheet(manual.teacher, manual.sectionA);
      expect(taking.students.map((st) => [st.arrival?.status, st.suggested])).toEqual([
        ['PRESENT', null],
        ['PRESENT', null],
        ['PRESENT', null],
      ]);
    });
  });

  describe('held back, then closed from the device', () => {
    it('no device seen for 15 minutes or more than half missing: nothing written, the today report says why; an admin closes it after the cutoff, once', async () => {
      const s = await setup();
      const other = await setup();
      // Section A: one of three arrived; section B: its one student.
      await punch(s, '07:51:00', [
        ['101', '07:50:00'],
        ['201', '07:50:30'],
      ]);
      clock.set(at('08:30:00'));
      expect((await close(s.admin, s.sectionA).expect(409)).body).toMatchObject({
        code: 'BEFORE_CUTOFF',
        cutoffAt: '09:00',
      });

      // No device call since 07:51: offline at the cutoff, so nothing is written.
      clock.set(at('09:00:00'));
      await processor.tick(s.tenantId);
      expect(await sessionCount(s.tenantId)).toBe(0);
      let report = await todayReport(s.admin);
      expect(sectionOf(report, s.sectionA).device).toEqual({
        arrived: 1,
        late: 0,
        enrolled: 3,
        notOnDevice: 0,
        cutoffAt: '09:00',
        state: 'DEVICE_OFFLINE',
      });
      expect(sectionOf(report, s.sectionB).device).toMatchObject({ state: 'DEVICE_OFFLINE' });
      // The admin closes B anyway (the web asks to confirm first).
      const closedB = (await close(s.admin, s.sectionB).expect(201)).body as CloseFromDeviceResult;
      expect(closedB).toEqual({
        sessionId: expect.any(String),
        submittedAt: at('09:00:00').toISOString(),
        counts: { present: 1, late: 0, absent: 0, leave: 0 },
      });
      expect(await rows(s, s.sectionB)).toEqual([['PRESENT', 'DEVICE']]);

      // The device is back: A stays held back, more than half of it missing.
      await tickAt(s, '09:05:00');
      expect(await registerOf(s)).toBeNull();
      report = await todayReport(s.admin);
      expect(sectionOf(report, s.sectionA).device).toMatchObject({ state: 'TOO_MANY_MISSING' });
      expect(sectionOf(report, s.sectionB).device).toMatchObject({ state: 'CLOSED' });
      expect(await f.smsLogs(s.tenantId)).toEqual([]);

      // Not for a teacher, nor for another institute's admin.
      await close(s.teacher, s.sectionA).expect(403);
      await close(other.admin, s.sectionA).expect(404);

      const closed = (await close(s.admin, s.sectionA).expect(201)).body as CloseFromDeviceResult;
      expect(closed.counts).toEqual({ present: 1, late: 0, absent: 2, leave: 0 });
      const register = await registerOf(s);
      expect(register).toMatchObject({
        id: closed.sessionId,
        version: 1,
        source: 'DEVICE',
        takenById: null,
        updatedById: null,
        submittedAt: at('09:05:00'),
      });
      expect(await rows(s)).toEqual([
        ['PRESENT', 'DEVICE'],
        ['ABSENT', 'DEVICE'],
        ['ABSENT', 'DEVICE'],
      ]);
      const admin = await userWithRole(s.tenantId, 'ADMIN');
      expect(await f.audits(s.tenantId, 'attendance_session', closed.sessionId)).toMatchObject([
        { action: 'CREATE', actorUserId: admin, newValues: { source: 'DEVICE', periodNo: 0 } },
      ]);
      await waitForSms(s.tenantId, 'SENT', 2);
      expect((await absentSms(s.tenantId)).map(([id]) => id).sort()).toEqual(
        [s.a[1]!.id, s.a[2]!.id].sort(),
      );

      expect((await close(s.admin, s.sectionA).expect(409)).body.code).toBe('REGISTER_EXISTS');
      expect(await sessionCount(s.tenantId)).toBe(2);
      expect(await absentSms(s.tenantId)).toHaveLength(2);
    });

    it('a student who cannot punch (no device ID, or not confirmed on a device) holds the section back; an admin may still close it', async () => {
      // 103 has an ID the device has not confirmed yet; a fourth student has no ID at all.
      const s = await setup({}, ['101', '102', '201']);
      const fourth = await enrol(s);
      await punch(s, '07:51:00', [
        ['101', '07:50:00'],
        ['102', '07:50:30'],
        ['201', '07:50:00'],
      ]);
      clock.set(at('08:30:00'));
      expect(sectionOf(await todayReport(s.admin), s.sectionA).device).toEqual({
        arrived: 2,
        late: 0,
        enrolled: 4,
        notOnDevice: 2,
        cutoffAt: '09:00',
        state: 'BEFORE_CUTOFF',
      });

      await tickAt(s, '09:00:00');
      expect(await registerOf(s)).toBeNull();
      expect(await rows(s, s.sectionB)).toEqual([['PRESENT', 'DEVICE']]);
      expect(sectionOf(await todayReport(s.admin), s.sectionA).device).toMatchObject({
        notOnDevice: 2,
        state: 'NOT_ON_DEVICE',
      });
      expect(await f.smsLogs(s.tenantId)).toEqual([]);

      // The admin confirms: those two are ABSENT, with the usual absent SMS.
      const closed = (await close(s.admin, s.sectionA).expect(201)).body as CloseFromDeviceResult;
      expect(closed.counts).toEqual({ present: 2, late: 0, absent: 2, leave: 0 });
      await waitForSms(s.tenantId, 'SENT', 2);
      expect((await absentSms(s.tenantId)).map(([id]) => id).sort()).toEqual(
        [s.a[2]!.id, fourth.id].sort(),
      );
    });

    it('an inactive student still enrolled does not hold the section back, is written ABSENT and gets no absent SMS', async () => {
      /** A setup with a fourth student in A who is INACTIVE (and has no device ID). */
      const withInactive = async () => {
        const s = await setup();
        const inactive = await enrol(s);
        await f.inTenant(s.tenantId, (tx) =>
          tx.student.update({ where: { id: inactive.id }, data: { status: 'INACTIVE' } }),
        );
        return { s, inactive };
      };
      const recordOf = async (s: Setup, studentId: string) =>
        (await registerOf(s))!.records.find((r) => r.studentId === studentId);

      // At the cutoff: 2 of 4 arrived; 103 (active) and the inactive student are ABSENT.
      const { s, inactive } = await withInactive();
      await punch(s, '07:51:00', [
        ['101', '07:50:00'],
        ['102', '07:50:30'],
        ['201', '07:50:00'],
      ]);
      clock.set(at('08:30:00'));
      expect(sectionOf(await todayReport(s.admin), s.sectionA).device).toMatchObject({
        enrolled: 4,
        notOnDevice: 0,
        state: 'BEFORE_CUTOFF',
      });
      await tickAt(s, '09:00:00');
      expect(await rows(s)).toEqual([
        ['PRESENT', 'DEVICE'],
        ['PRESENT', 'DEVICE'],
        ['ABSENT', 'DEVICE'],
      ]);
      // Still on the register's roster (a submit expects them too), but no SMS for them.
      expect(await recordOf(s, inactive.id)).toEqual({
        studentId: inactive.id,
        status: 'ABSENT',
        source: 'DEVICE',
      });
      await waitForSms(s.tenantId, 'SENT', 1);
      expect(await absentSms(s.tenantId)).toEqual([[s.a[2]!.id, `absent:${s.a[2]!.id}:${DAY}`]]);
      expect(h.sms.sentTo(inactive.phone)).toEqual([]);

      // Closed from the device by an admin: the same.
      const held = await withInactive();
      await punch(held.s, '07:51:00', [['101', '07:50:00']]);
      await tickAt(held.s, '09:00:00');
      expect(await registerOf(held.s)).toBeNull();
      const closed = (await close(held.s.admin, held.s.sectionA).expect(201))
        .body as CloseFromDeviceResult;
      expect(closed.counts).toEqual({ present: 1, late: 0, absent: 3, leave: 0 });
      expect((await recordOf(held.s, held.inactive.id))?.status).toBe('ABSENT');
      await waitForSms(held.s.tenantId, 'SENT', 2);
      expect((await absentSms(held.s.tenantId)).map(([id]) => id).sort()).toEqual(
        [held.s.a[1]!.id, held.s.a[2]!.id].sort(),
      );
      expect(h.sms.sentTo(held.inactive.phone)).toEqual([]);
    });

    it('a held-back section closes by itself only within an hour after its cutoff; later it waits for a person', async () => {
      const s = await setup();
      // A: one of three by the cutoff; B: nobody.
      await punch(s, '07:51:00', [['101', '07:50:00']]);
      await tickAt(s, '09:00:00');
      expect(await sessionCount(s.tenantId)).toBe(0);

      // Within the hour A's late arrivals let it close.
      await punch(s, '09:30:30', [['102', '09:30:00']]);
      await tickAt(s, '09:31:00');
      expect(await rows(s)).toEqual([
        ['PRESENT', 'DEVICE'],
        ['LATE', 'DEVICE'],
        ['ABSENT', 'DEVICE'],
      ]);
      const sent = (await f.smsLogs(s.tenantId)).length;

      // B's student arrives after 10:00: no register, no surprise absent SMS.
      await punch(s, '10:00:30', [['201', '10:00:00']]);
      await tickAt(s, '10:01:00');
      expect(await registerOf(s, s.sectionB)).toBeNull();
      expect(sectionOf(await todayReport(s.admin), s.sectionB).device).toMatchObject({
        arrived: 1,
        state: 'AUTO_CLOSE_ENDED',
      });
      await tickAt(s, '12:00:00');
      expect(await registerOf(s, s.sectionB)).toBeNull();
      expect(await f.smsLogs(s.tenantId)).toHaveLength(sent);

      // A person closes it.
      await close(s.admin, s.sectionB).expect(201);
      expect(await rows(s, s.sectionB)).toEqual([['LATE', 'DEVICE']]);
    });

    it('waiting more than 5 s for the punch lock answers 409 BUSY with Retry-After', async () => {
      const s = await setup();
      clock.set(at('09:05:00'));
      // Another transaction holds the institute's punch lock (a long batch).
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
      // Should the wait not be limited, the holder still lets go after 9 s.
      const failsafe = setTimeout(release, 9_000);
      const started = Date.now();
      const res = await close(s.admin, s.sectionA);
      expect(Date.now() - started).toBeLessThan(9_000);
      clearTimeout(failsafe);
      release();
      await holder;
      expect(res.status).toBe(409);
      expect(res.headers['retry-after']).toBe('2');
      expect(res.body).toMatchObject({ code: 'BUSY' });
      expect(await registerOf(s)).toBeNull();
    });
  });

  describe('the register API', () => {
    it("the take screen shows each student's arrival; a register not taken yet starts from the device's view", async () => {
      const s = await setup();
      await punch(s, '08:10:30', [
        ['101', '08:10:00'],
        ['102', '08:10:01'],
      ]);
      clock.set(at('08:30:00'));
      const before = await sheet(s.teacher, s.sectionA);
      expect(before.session).toBeNull();
      expect(before.students.map((st) => [st.id, st.arrival, st.suggested])).toEqual([
        [s.a[0]!.id, { at: at('08:10:00').toISOString(), status: 'PRESENT' }, 'PRESENT'],
        [s.a[1]!.id, { at: at('08:10:01').toISOString(), status: 'LATE' }, 'LATE'],
        [s.a[2]!.id, null, 'ABSENT'],
      ]);

      // Once the register exists there is nothing to suggest; arrivals stay.
      await tickAt(s, '09:00:00');
      const after = await sheet(s.teacher, s.sectionA);
      expect(after.students.map((st) => [st.arrival?.status ?? null, st.suggested])).toEqual([
        ['PRESENT', null],
        ['LATE', null],
        [null, null],
      ]);
      expect(after.session).toMatchObject({
        version: 1,
        source: 'DEVICE',
        updatedByDevice: true,
        updatedBy: { id: '', name: '' },
      });
      expect(after.session!.records.map((r) => r.source)).toEqual(['DEVICE', 'DEVICE', 'DEVICE']);
    });

    it('a teacher fixing one record of a DEVICE register makes it MANUAL: the others stay DEVICE, a later punch changes nothing, no second absent SMS', async () => {
      const s = await setup();
      const teacher = await userWithRole(s.tenantId, 'TEACHER', s.sectionA);
      await punch(s, '07:51:00', [
        ['101', '07:50:00'],
        ['102', '07:50:30'],
      ]);
      await tickAt(s, '09:00:00');
      await waitForSms(s.tenantId, 'SENT', 1);

      // Student 2 went home sick: on leave. Student 3 stays absent.
      clock.set(at('09:10:00'));
      await submit(s.teacher, s, 1, ['PRESENT', 'LEAVE', 'ABSENT']).expect(200);
      const register = await registerOf(s);
      expect(register).toMatchObject({
        version: 2,
        source: 'DEVICE',
        takenById: null,
        updatedById: teacher,
      });
      expect(await rows(s)).toEqual([
        ['PRESENT', 'DEVICE'],
        ['LEAVE', 'MANUAL'],
        ['ABSENT', 'DEVICE'],
      ]);
      expect((await f.audits(s.tenantId, 'attendance_session', register!.id)).at(-1)).toEqual({
        action: 'UPDATE',
        actorUserId: teacher,
        oldValues: { [s.a[1]!.id]: { status: 'PRESENT', source: 'DEVICE' } },
        newValues: { [s.a[1]!.id]: { status: 'LEAVE', source: 'MANUAL' }, lateEdit: false },
      });
      expect((await sheet(s.teacher, s.sectionA)).session).toMatchObject({
        source: 'DEVICE',
        updatedByDevice: false,
        updatedBy: { id: teacher },
      });

      // Student 2 punches again, student 3 arrives: the person's record stays, the device's moves.
      await punch(s, '09:31:00', [
        ['102', '09:30:00'],
        ['103', '09:30:30'],
      ]);
      expect(await rows(s)).toEqual([
        ['PRESENT', 'DEVICE'],
        ['LEAVE', 'MANUAL'],
        ['LATE', 'DEVICE'],
      ]);
      expect(await registerOf(s)).toMatchObject({ version: 3, updatedById: null });

      await new Promise((r) => setTimeout(r, 300));
      expect(await absentSms(s.tenantId)).toEqual([[s.a[2]!.id, `absent:${s.a[2]!.id}:${DAY}`]]);
      expect(h.sms.sentTo(s.a[2]!.phone)).toHaveLength(1);

      // The student report says who set each day.
      const report = async (studentId: string) =>
        (
          await http(h)
            .get(`/attendance/reports/students/${studentId}`)
            .query({ from: DAY, to: DAY })
            .set(bearer(s.admin))
            .expect(200)
        ).body as StudentAttendanceReport;
      expect((await report(s.a[1]!.id)).days).toEqual([
        { date: DAY, status: 'LEAVE', source: 'MANUAL', nonWorkingDay: null },
      ]);
      expect((await report(s.a[2]!.id)).days).toEqual([
        { date: DAY, status: 'LATE', source: 'DEVICE', nonWorkingDay: null },
      ]);
    });

    it('a student enrolled after the register was written: the teacher’s submit adds their record (MANUAL)', async () => {
      const s = await setup();
      const teacher = await userWithRole(s.tenantId, 'TEACHER', s.sectionA);
      await punch(s, '07:51:00', [
        ['101', '07:50:00'],
        ['102', '07:50:30'],
        ['103', '07:51:00'],
      ]);
      await tickAt(s, '09:00:00');
      const fourth = await enrol(s);

      clock.set(at('09:20:00'));
      const taking = await sheet(s.teacher, s.sectionA);
      expect(taking.students).toHaveLength(4);
      expect(taking.session!.records).toHaveLength(3);
      const res = await http(h)
        .put('/attendance/sessions')
        .set(bearer(s.teacher))
        .send({
          sectionId: s.sectionA,
          date: DAY,
          baseVersion: 1,
          submissionId: randomUUID(),
          records: [
            ...s.a.map((st) => ({ studentId: st.id, status: 'PRESENT' })),
            { studentId: fourth.id, status: 'LATE' },
          ],
        })
        .expect(200);
      expect(res.body.session).toMatchObject({ version: 2, source: 'DEVICE' });
      const register = await registerOf(s);
      expect(register!.records.find((r) => r.studentId === fourth.id)).toEqual({
        studentId: fourth.id,
        status: 'LATE',
        source: 'MANUAL',
      });
      expect(await rows(s)).toEqual([
        ['PRESENT', 'DEVICE'],
        ['PRESENT', 'DEVICE'],
        ['PRESENT', 'DEVICE'],
      ]);
      expect((await f.audits(s.tenantId, 'attendance_session', register!.id)).at(-1)).toEqual({
        action: 'UPDATE',
        actorUserId: teacher,
        oldValues: { [fourth.id]: null },
        newValues: { [fourth.id]: { status: 'LATE', source: 'MANUAL' }, lateEdit: false },
      });
    });

    it('a draft older than a change by the device gets a conflict that names the device', async () => {
      const s = await setup();
      await punch(s, '07:51:00', [
        ['101', '07:50:00'],
        ['102', '07:50:30'],
      ]);
      await tickAt(s, '09:00:00');
      expect((await sheet(s.teacher, s.sectionA)).session!.version).toBe(1);
      await punch(s, '09:11:00', [['103', '09:10:00']]);

      const conflict = await submit(s.teacher, s, 1, ['PRESENT', 'PRESENT', 'LEAVE']).expect(409);
      expect(conflict.body).toMatchObject({
        code: 'VERSION_CONFLICT',
        session: {
          version: 2,
          source: 'DEVICE',
          updatedByDevice: true,
          updatedBy: { id: '', name: '' },
          submittedAt: at('09:11:00').toISOString(),
        },
      });
      expect(conflict.body.session.records).toContainEqual({
        studentId: s.a[2]!.id,
        status: 'LATE',
        note: null,
        source: 'DEVICE',
      });
    });
  });

  it('one batch of the slowest punches (entry SMS and a DEVICE register change each) stays well under the 15 s job limit', async () => {
    const s = await f.institute({
      deviceAutoMark: true,
      entrySmsEnabled: true,
      deviceMaxPunchesPerMinute: 240,
    });
    // PUNCH_BATCH more students in section A, each mapped, with a guardian, ABSENT on the
    // register the cutoff wrote.
    const ids = Array.from({ length: PUNCH_BATCH }, () => randomUUID());
    await withTenant(
      h.prisma,
      s.tenantId,
      async (tx) => {
        const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
        const section = await tx.section.findUniqueOrThrow({ where: { id: s.sectionA } });
        const guardians = ids.map(() => randomUUID());
        await tx.student.createMany({
          data: ids.map((id, i) => ({
            id,
            tenantId: s.tenantId,
            studentCode: `P-${i}-${id.slice(0, 8)}`,
            nameBn: `ছাত্র ${i}`,
          })),
        });
        await tx.enrolment.createMany({
          data: ids.map((id, i) => ({
            tenantId: s.tenantId,
            studentId: id,
            academicYearId: year.id,
            classLevelId: section.classLevelId,
            sectionId: s.sectionA,
            roll: 10 + i,
          })),
        });
        await tx.guardian.createMany({
          data: guardians.map((id) => ({
            id,
            tenantId: s.tenantId,
            nameEn: 'Parent',
            phone: randomPhone(),
          })),
        });
        await tx.studentGuardian.createMany({
          data: ids.map((id, i) => ({
            tenantId: s.tenantId,
            studentId: id,
            guardianId: guardians[i]!,
            relation: 'FATHER' as const,
            isPrimary: true,
          })),
        });
        await tx.devicePerson.createMany({
          data: ids.map((id, i) => ({
            tenantId: s.tenantId,
            deviceUserId: String(1000 + i),
            studentId: id,
          })),
        });
        const session = await tx.attendanceSession.create({
          data: {
            tenantId: s.tenantId,
            sectionId: s.sectionA,
            date: dateToDb(DAY),
            periodNo: 0,
            source: 'DEVICE',
            submittedAt: at('09:00:00'),
            lastSubmissionId: randomUUID(),
          },
        });
        await tx.attendanceRecord.createMany({
          data: [...s.a.map((st) => st.id), ...ids].map((studentId) => ({
            tenantId: s.tenantId,
            sessionId: session.id,
            studentId,
            status: 'ABSENT' as const,
            source: 'DEVICE' as const,
          })),
        });
      },
      { timeout: 60_000 },
    );
    // Late arrivals over three minutes (under 240 a minute), received in real time.
    const reader = f.sim(s.device.serialNo);
    clock.set(at('09:23:00'));
    const start = at('09:20:00').getTime();
    const res = await reader.uploadAttlog(
      ids.map((_, i) =>
        reader.attlogLine(
          String(1000 + i),
          new Date(start + Math.floor((i * 180) / PUNCH_BATCH) * 1000),
        ),
      ),
    );
    expect(res.status).toBe(200);
    await f.holdJob(s.tenantId);

    // Measured inside the job transaction, which is then rolled back: no SMS is queued for the
    // workers every test file shares.
    let elapsed = 0;
    const done = new Error('rolled back');
    await expect(
      h.app.get(TenantJobRunner).run(s.tenantId, async () => {
        const started = performance.now();
        expect(await h.app.get(PunchProcessingService).processBatch(PUNCH_BATCH)).toBe(PUNCH_BATCH);
        elapsed = performance.now() - started;
        const tx = h.app.get(Db).tx;
        expect(await tx.smsLog.count({ where: { purpose: 'ATTENDANCE_ENTRY' } })).toBe(PUNCH_BATCH);
        expect(await tx.attendanceRecord.count({ where: { status: 'LATE' } })).toBe(PUNCH_BATCH);
        expect(await tx.devicePunch.count({ where: { outcome: 'APPLIED' } })).toBe(PUNCH_BATCH);
        throw done;
      }),
    ).rejects.toBe(done);
    expect(elapsed).toBeGreaterThan(0);
    // 3.6–4.8 s on a development machine (see the T12 report); generous for slower ones.
    expect(elapsed).toBeLessThan(12_000);
    expect(await f.smsLogs(s.tenantId)).toEqual([]);
  });
});

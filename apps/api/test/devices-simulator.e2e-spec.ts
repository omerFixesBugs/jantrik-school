import { ZkDeviceSimulator } from '@jantrik/device-sim';
import {
  entrySmsText,
  type AttendanceSheet,
  type AttendanceTodayReport,
  type DevicePeopleList,
  type DeviceSyncResult,
} from '@jantrik/shared';
import { DevicesProcessor } from '../src/devices/devices.processor.js';
import { FakeClock } from './support/clock.js';
import { bearer, createHarness, http, randomIp, type Harness } from './support/harness.js';
import { createIngestHarness, type IngestHarness } from './support/ingest.js';
import { dhaka, punchFixtures } from './support/punches.js';
import { school } from './support/school.js';

// The device simulator (@jantrik/device-sim) against the receiver, end to end: people sent to the
// devices, a morning of punches, the devices worker, and the register written at the cutoff. Both
// apps share one FakeClock. 2026-10-21 is a Wednesday; section A starts at 08:00 (LATE after
// 08:10:00) and its register is due at 09:00.

const DAY = '2026-10-21';
const at = (time: string) => dhaka(DAY, time);
const INSTITUTE = 'Test Institute';

describe('device simulator end to end', () => {
  const clock = new FakeClock(at('07:00:00'));
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

  it('people sent to two devices, a morning of punches (a slow clock, a backlog, a batch sent twice), the cutoff: the register, the arrival times and exactly the expected SMS', async () => {
    const s = await school(h, { settings: { deviceAutoMark: true, entrySmsEnabled: true } });
    const admin = bearer(s.admin);
    const step = async (time: string, fn: () => Promise<unknown>) => {
      clock.set(at(time));
      await fn();
      await f.settled(s.tenantId);
    };

    // Device IDs first, then the two devices: the gate keeps time, the side door runs 3 minutes
    // slow (it shows 08:08:30 at 08:11:30).
    const ids: [string, string][] = [
      [s.a[0]!.id, '101'],
      [s.a[1]!.id, '102'],
      [s.a[2]!.id, '103'],
      [s.b[0]!.id, '201'],
    ];
    for (const [studentId, deviceUserId] of ids) {
      await http(h)
        .put('/attendance/device-people')
        .set(admin)
        .send({ studentId, deviceUserId })
        .expect(200);
    }
    const gateRow = await f.addDevice(s.tenantId);
    const doorRow = await f.addDevice(s.tenantId);
    const gate = new ZkDeviceSimulator({
      baseUrl: ingest.baseUrl,
      sn: gateRow.serialNo,
      forwardedFor: randomIp(),
    });
    const door = new ZkDeviceSimulator({
      baseUrl: ingest.baseUrl,
      sn: doorRow.serialNo,
      forwardedFor: randomIp(),
      clockSkewSec: -180,
    });
    const onDoor = (time: string) => new Date(at(time).getTime() - 180_000);

    // Handshake, "send people", and each device polls and applies the commands.
    clock.set(at('07:30:00'));
    for (const device of [gate, door]) expect((await device.handshake()).status).toBe(200);
    for (const row of [gateRow, doorRow]) {
      const sync = await http(h).post(`/attendance/devices/${row.id}/sync`).set(admin).expect(200);
      expect(sync.body as DeviceSyncResult).toEqual({ queued: 4, skipped: 0 });
    }
    clock.set(at('07:31:00'));
    for (const device of [gate, door]) {
      expect((await device.poll(true)).commands.map((c) => c.returnCode)).toEqual([0, 0, 0, 0]);
      expect(device.users).toEqual(
        new Map([
          ['101', 'Student 1'],
          ['102', 'Student 2'],
          ['103', 'Student 3'],
          ['201', 'Student 1'],
        ]),
      );
    }
    const people = (
      await http(h).get('/attendance/device-people').query({ kind: 'STUDENT' }).set(admin)
    ).body as DevicePeopleList;
    expect(people.people.map((p) => [p.deviceUserId, p.sync])).toEqual([
      ['101', 'DONE'],
      ['102', 'DONE'],
      ['103', 'DONE'],
      ['201', 'DONE'],
    ]);

    // The side door's error is learnt from three cards punched on it one minute apart (visitors,
    // unknown to the institute).
    clock.set(at('07:39:30'));
    await door.poll();
    for (const [pin, time] of [
      ['901', '07:40:00'],
      ['902', '07:41:00'],
      ['903', '07:42:00'],
    ] as const) {
      await step(time, () => door.punch(pin, { at: onDoor(time) }));
    }
    // Student 1 at the gate on time; then the gate sends the same batch again.
    await step('07:50:00', () => gate.punch('101', { at: at('07:50:00') }));
    await step('07:51:00', async () => {
      const again = await gate.uploadAttlog([gate.attlogLine('101', at('07:50:00'))]);
      expect(again).toEqual({ status: 200, body: 'OK: 1' });
    });
    // Student 2 at the slow side door at 08:11:30 (it shows 08:08:30): late.
    clock.set(at('08:11:00'));
    await door.poll();
    await step('08:11:30', () => door.punch('102', { at: onDoor('08:11:30') }));
    // The gate was offline and uploads its backlog: section B's student at 07:55.
    await step('08:20:00', () => gate.uploadAttlog([gate.attlogLine('201', at('07:55:00'))]));
    // Student 1 again: no second entry SMS.
    await step('08:30:00', () => gate.punch('101', { at: at('08:30:00') }));

    const punches = await f.punches(s.tenantId);
    expect(
      punches.map((p) => [p.deviceUserId, p.punchedAt.toISOString(), p.flags, p.outcome]),
    ).toEqual([
      ['901', onDoor('07:40:00').toISOString(), [], 'UNMAPPED'],
      ['902', onDoor('07:41:00').toISOString(), [], 'UNMAPPED'],
      ['903', onDoor('07:42:00').toISOString(), [], 'UNMAPPED'],
      ['101', at('07:50:00').toISOString(), [], 'APPLIED'],
      ['201', at('07:55:00').toISOString(), [], 'APPLIED'],
      ['102', at('08:11:30').toISOString(), ['CLOCK_CORRECTED'], 'APPLIED'],
      ['101', at('08:30:00').toISOString(), [], 'APPLIED'],
    ]);
    // Before the cutoff: no register, the arrivals counted live.
    const live = (await http(h).get('/attendance/reports/today').set(admin).expect(200))
      .body as AttendanceTodayReport;
    expect(live.sections.map((x) => [x.device, x.register])).toEqual([
      [{ arrived: 2, late: 1, enrolled: 3, cutoffAt: '09:00', state: 'BEFORE_CUTOFF' }, null],
      [{ arrived: 1, late: 0, enrolled: 1, cutoffAt: '09:00', state: 'BEFORE_CUTOFF' }, null],
    ]);

    // Past the cutoff: both devices call in and the minute tick runs.
    clock.set(at('09:00:30'));
    for (const device of [gate, door]) await device.poll();
    await h.app.get(DevicesProcessor).tick(s.tenantId);

    const sheet = (
      await http(h)
        .get('/attendance/sessions')
        .query({ sectionId: s.sectionA, date: DAY })
        .set(bearer(s.teacher))
        .expect(200)
    ).body as AttendanceSheet;
    expect(sheet.session).toMatchObject({ version: 1, source: 'DEVICE', updatedByDevice: true });
    const status = new Map(sheet.session!.records.map((r) => [r.studentId, [r.status, r.source]]));
    expect(sheet.students.map((st) => [status.get(st.id), st.arrival])).toEqual([
      [['PRESENT', 'DEVICE'], { at: at('07:50:00').toISOString(), status: 'PRESENT' }],
      [['LATE', 'DEVICE'], { at: at('08:11:30').toISOString(), status: 'LATE' }],
      [['ABSENT', 'DEVICE'], null],
    ]);
    const report = (await http(h).get('/attendance/reports/today').set(admin).expect(200))
      .body as AttendanceTodayReport;
    expect(report.sections.map((x) => [x.device?.state, x.register?.counts])).toEqual([
      ['CLOSED', { present: 1, absent: 1, late: 1, leave: 0 }],
      ['CLOSED', { present: 1, absent: 0, late: 0, leave: 0 }],
    ]);

    // Exactly two entry SMS (the backlog and the second punch send none) and one absent SMS.
    await vi.waitFor(
      async () => {
        const sent = (await f.smsLogs(s.tenantId)).filter((l) => l.status === 'SENT');
        if (sent.length < 3) throw new Error('not sent yet');
      },
      { timeout: 5_000, interval: 50 },
    );
    expect((await f.smsLogs(s.tenantId)).map((l) => [l.purpose, l.relatedId, l.status])).toEqual([
      ['ATTENDANCE_ENTRY', s.a[0]!.id, 'SENT'],
      ['ATTENDANCE_ENTRY', s.a[1]!.id, 'SENT'],
      ['ATTENDANCE_ABSENT', s.a[2]!.id, 'SENT'],
    ]);
    expect(h.sms.sentTo(s.a[0]!.phone)).toEqual([
      entrySmsText({ student: 'ছাত্র 1', at: at('07:50:00'), institute: INSTITUTE }),
    ]);
    expect(h.sms.sentTo(s.a[1]!.phone)).toEqual([
      entrySmsText({ student: 'ছাত্র 2', at: at('08:11:30'), institute: INSTITUTE }),
    ]);
    expect(h.sms.sentTo(s.a[2]!.phone)).toHaveLength(1);
    expect(h.sms.sentTo(s.b[0]!.phone)).toEqual([]);
  });
});

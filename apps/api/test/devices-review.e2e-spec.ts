import type { FeedPunch } from '@jantrik/shared';
import { FakeClock } from './support/clock.js';
import { createHarness, type Harness } from './support/harness.js';
import { createIngestHarness, type IngestHarness } from './support/ingest.js';
import { dhaka, punchFixtures, type Institute } from './support/punches.js';

// Punch reviews (spoofing defence) at the API: a review that changes whether a punch counts sets
// its outcome and rebuilds that person's day (the student's DEVICE record, the staff day) in the
// review's transaction. Reviews never send entry or exit SMS. 2026-10-21 is a Wednesday.

const DAY = '2026-10-21';
const at = (time: string) => dhaka(DAY, time);

describe('punch review effects', () => {
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

  /** Ten unknown IDs fill the minute 08:05 (the cap is 10), so these punches after them are held. */
  const burst = async (s: Institute, held: [string, string][]) => {
    clock.set(at('08:06:00'));
    await f.upload(f.sim(s.device.serialNo), DAY, [
      ...Array.from({ length: 10 }, (_, i) => [String(600 + i), `08:05:0${i}`] as [string, string]),
      ...held,
    ]);
    await f.settled(s.tenantId);
  };
  const reviewed = async (
    s: Institute,
    id: string,
    action: 'OK' | 'ACCEPT' | 'REJECT',
  ): Promise<FeedPunch> => (await f.review(s.admin, id, action).expect(200)).body as FeedPunch;

  it("ACCEPT applies a held punch: the student's DEVICE record and the staff day; no SMS", async () => {
    const s = await f.institute({
      deviceMaxPunchesPerMinute: 10,
      deviceAutoMark: true,
      entrySmsEnabled: true,
      exitSmsEnabled: true,
    });
    const teacher = await f.staff(s.tenantId, ['TEACHER']);
    await f.map(s.tenantId, [
      { deviceUserId: '101', studentId: s.a[0]!.id },
      { deviceUserId: '9001', staffUserId: teacher },
    ]);
    const sessionId = await f.deviceRegister(s, DAY, [
      { status: 'ABSENT' },
      { status: 'ABSENT' },
      { status: 'ABSENT' },
    ]);
    await burst(s, [
      ['101', '08:05:30'],
      ['9001', '08:05:40'],
    ]);
    const held = (await f.punches(s.tenantId)).filter((p) => p.outcome === 'HELD');
    expect(held.map((p) => [p.deviceUserId, p.flags])).toEqual([
      ['101', ['BURST']],
      ['9001', ['BURST']],
    ]);
    expect(await f.staffDays(s.tenantId)).toEqual([]);
    expect(await f.statusOf(s.tenantId, sessionId, s.a[0]!.id)).toBe('ABSENT');

    clock.set(at('08:10:00'));
    expect(await reviewed(s, held[0]!.id, 'ACCEPT')).toMatchObject({
      review: 'ACCEPTED',
      outcome: 'APPLIED',
    });
    expect(await f.register(s.tenantId, sessionId)).toMatchObject({
      version: 2,
      source: 'DEVICE',
      updatedById: null,
      submittedAt: at('08:10:00'),
    });
    expect(await f.statusOf(s.tenantId, sessionId, s.a[0]!.id)).toBe('PRESENT');
    expect(await reviewed(s, held[1]!.id, 'ACCEPT')).toMatchObject({ outcome: 'APPLIED' });
    expect(
      (await f.staffDays(s.tenantId)).map((d) => [d.userId, d.status, d.source, d.inAt]),
    ).toEqual([[teacher, 'PRESENT', 'DEVICE', at('08:05:40')]]);

    // Reviews send no entry or exit SMS (and PRESENT no absent SMS).
    expect(await f.smsLogs(s.tenantId)).toEqual([]);
    // Audited: the review, and the register change with the admin as the actor.
    const [review] = await f.audits(s.tenantId, 'device_punch', held[0]!.id);
    expect(review).toMatchObject({
      action: 'UPDATE',
      oldValues: { review: null },
      newValues: { review: 'ACCEPTED' },
    });
    expect(await f.audits(s.tenantId, 'attendance_session', sessionId)).toEqual([
      {
        action: 'UPDATE',
        actorUserId: review!.actorUserId,
        oldValues: { [s.a[0]!.id]: 'ABSENT' },
        newValues: { [s.a[0]!.id]: 'PRESENT', source: 'DEVICE' },
      },
    ]);
    expect(review!.actorUserId).toEqual(expect.any(String));
  });

  it("REJECT of a staff member's only punch makes their DEVICE day ABSENT; OK makes it count again", async () => {
    const s = await f.institute();
    const teacher = await f.staff(s.tenantId, ['TEACHER']);
    await f.map(s.tenantId, [{ deviceUserId: '9001', staffUserId: teacher }]);
    clock.set(at('08:31:00'));
    await f.upload(f.sim(s.device.serialNo), DAY, [['9001', '08:30:00']]);
    await f.settled(s.tenantId);
    const [punch] = await f.punches(s.tenantId);
    const day = async () => {
      const [d] = await f.staffDays(s.tenantId);
      return { status: d!.status, source: d!.source, inAt: d!.inAt, version: d!.version };
    };
    expect(await day()).toEqual({
      status: 'PRESENT',
      source: 'DEVICE',
      inAt: at('08:30:00'),
      version: 1,
    });

    expect(await reviewed(s, punch!.id, 'REJECT')).toMatchObject({
      review: 'REJECTED',
      outcome: 'IGNORED',
    });
    const [rejected] = await f.staffDays(s.tenantId);
    expect(rejected).toMatchObject({
      status: 'ABSENT',
      source: 'DEVICE',
      inAt: null,
      outAt: null,
      lateMinutes: 0,
      earlyMinutes: 0,
      version: 2,
    });

    expect(await reviewed(s, punch!.id, 'OK')).toMatchObject({ review: 'OK', outcome: 'APPLIED' });
    expect(await day()).toEqual({
      status: 'PRESENT',
      source: 'DEVICE',
      inAt: at('08:30:00'),
      version: 3,
    });
    expect((await f.audits(s.tenantId, 'device_punch', punch!.id)).map((a) => a.newValues)).toEqual(
      [{ review: 'REJECTED' }, { review: 'OK' }],
    );
  });

  it("REJECT of a student's only IN on a DEVICE register: ABSENT, and one absent SMS after reject, accept, reject", async () => {
    const s = await f.institute({
      deviceMaxPunchesPerMinute: 10,
      deviceAutoMark: true,
      absentSmsDelayMinutes: 10,
    });
    await f.map(s.tenantId, [{ deviceUserId: '101', studentId: s.a[0]!.id }]);
    const sessionId = await f.deviceRegister(s, DAY, [
      { status: 'ABSENT' },
      { status: 'PRESENT' },
      { status: 'PRESENT' },
    ]);
    await burst(s, [['101', '08:05:30']]);
    const punch = await f.punchOf(s.tenantId, '101', at('08:05:30'));
    expect(punch.outcome).toBe('HELD');

    const steps = [
      ['ACCEPT', 'PRESENT', 'APPLIED'],
      ['REJECT', 'ABSENT', 'IGNORED'],
      ['ACCEPT', 'PRESENT', 'APPLIED'],
      ['REJECT', 'ABSENT', 'IGNORED'],
    ] as const;
    for (const [action, status, outcome] of steps) {
      expect((await reviewed(s, punch.id, action)).outcome).toBe(outcome);
      expect(await f.statusOf(s.tenantId, sessionId, s.a[0]!.id)).toBe(status);
    }
    expect((await f.smsLogs(s.tenantId)).map((l) => [l.purpose, l.dedupeKey, l.status])).toEqual([
      ['ATTENDANCE_ABSENT', `absent:${s.a[0]!.id}:${DAY}`, 'QUEUED'],
    ]);
    expect((await f.register(s.tenantId, sessionId)).version).toBe(5);
    expect(await f.audits(s.tenantId, 'device_punch', punch.id)).toHaveLength(4);
    expect(
      (await f.audits(s.tenantId, 'attendance_session', sessionId)).map((a) => a.newValues),
    ).toEqual(steps.map(([, status]) => ({ [s.a[0]!.id]: status, source: 'DEVICE' })));
  });

  it('OK changes nothing; flagged punches count but send no SMS', async () => {
    clock.set(at('04:00:00'));
    const s = await f.institute({ deviceAutoMark: true, entrySmsEnabled: true });
    await f.map(s.tenantId, [
      { deviceUserId: '101', studentId: s.a[0]!.id },
      { deviceUserId: '102', studentId: s.a[1]!.id },
    ]);
    const sessionId = await f.deviceRegister(s, DAY, [
      { status: 'ABSENT' },
      { status: 'ABSENT' },
      { status: 'PRESENT' },
    ]);
    // Before 05:00 (OUTSIDE_HOURS), from the device's first address (trusted).
    const home = f.sim(s.device.serialNo);
    clock.set(at('04:31:00'));
    await f.upload(home, DAY, [['102', '04:30:00']]);
    await f.settled(s.tenantId);
    // From another address: NEW_IP.
    clock.set(at('07:51:00'));
    await f.upload(f.sim(s.device.serialNo), DAY, [['101', '07:50:00']]);
    await f.settled(s.tenantId);

    // Both count: the register follows them. Neither sends an entry SMS.
    expect(await f.statusOf(s.tenantId, sessionId, s.a[0]!.id)).toBe('PRESENT');
    expect(await f.statusOf(s.tenantId, sessionId, s.a[1]!.id)).toBe('PRESENT');
    expect(await f.smsLogs(s.tenantId)).toEqual([]);
    const { version } = await f.register(s.tenantId, sessionId);

    const flagged = await f.punchOf(s.tenantId, '101', at('07:50:00'));
    expect(flagged.flags).toEqual(['NEW_IP']);
    expect(await reviewed(s, flagged.id, 'OK')).toMatchObject({
      review: 'OK',
      outcome: 'APPLIED',
    });
    expect((await f.register(s.tenantId, sessionId)).version).toBe(version);
    expect(await f.smsLogs(s.tenantId)).toEqual([]);
    expect(await f.audits(s.tenantId, 'device_punch', flagged.id)).toEqual([
      {
        action: 'UPDATE',
        actorUserId: expect.any(String),
        oldValues: { review: null },
        newValues: { review: 'OK' },
      },
    ]);
  });
});

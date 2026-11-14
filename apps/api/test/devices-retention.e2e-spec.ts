import { Logger } from '@nestjs/common';
import { addDays, dateFromDb, todayIn, type IsoDate } from '@jantrik/shared';
import type { Job } from 'bullmq';
import { RequestContext } from '../src/common/request-context.js';
import { DeviceRetentionService } from '../src/devices/device-retention.service.js';
import {
  DEVICES_TENANTS_KEY,
  DEVICES_TICK_JOB,
  EXPIRE_PUNCHES_JOB,
} from '../src/devices/devices.constants.js';
import { DevicesProcessor, RETENTION_CHUNK } from '../src/devices/devices.processor.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import { FakeClock } from './support/clock.js';
import { createHarness, createTenant, type Harness } from './support/harness.js';
import { createIngestHarness, type IngestHarness } from './support/ingest.js';
import { dhaka, punchFixtures } from './support/punches.js';

// Retention (expire-punches): raw punches past each institute's punch_retention_days, and command
// rows no longer needed, are deleted daily; attendance built from them stays. Punches come through
// the receiver (@jantrik/device-sim) on the day the clock shows; both apps share one FakeClock.
// The job runs on 2026-10-21 at 00:40, as scheduled.

const TODAY = '2026-10-21';
const DAY_MS = 86_400_000;
const day = (n: number) => addDays(TODAY, n);
/** The days a device recorded a student and a teacher, relative to TODAY. */
const HISTORY = [-731, -730, -40, -35, -30, -10];

describe('device retention (expire-punches)', () => {
  const clock = new FakeClock(dhaka(TODAY, '00:40:00'));
  let h: Harness;
  let ingest: IngestHarness;
  let processor: DevicesProcessor;
  let retention: DeviceRetentionService;
  let runner: TenantJobRunner;
  const f = punchFixtures(
    () => h,
    () => ingest,
    clock,
  );

  beforeAll(async () => {
    h = await createHarness({ clock });
    ingest = await createIngestHarness({ clock });
    processor = h.app.get(DevicesProcessor);
    retention = h.app.get(DeviceRetentionService);
    runner = h.app.get(TenantJobRunner);
  });
  afterAll(async () => {
    await ingest.queue.obliterate({ force: true });
    await ingest.close();
    await h.close();
  });
  beforeEach(() => clock.set(dhaka(TODAY, '00:40:00')));
  afterEach(() => vi.restoreAllMocks());

  const runJob = () => processor.process({ name: EXPIRE_PUNCHES_JOB } as unknown as Job);
  /** Only these institutes are listed for the job (process-punches jobs list theirs too). */
  const list = async (...tenantIds: string[]) => {
    await h.redis.del(DEVICES_TENANTS_KEY);
    await Promise.all(tenantIds.map((id) => h.redis.zadd(DEVICES_TENANTS_KEY, Date.now(), id)));
  };
  const punchDays = async (tenantId: string) =>
    (await f.punches(tenantId)).map((p) => dateFromDb(p.localDate));
  /** These days twice (the student's punch, then the teacher's), as `punchDays` lists them. */
  const twice = (days: number[]) => days.flatMap((n) => [day(n), day(n)]);

  /** What retention must never touch: registers with their records, staff days, SMS and audit. */
  const keptRows = (tenantId: string) =>
    f.inTenant(tenantId, async (tx) => ({
      registers: await tx.attendanceSession.findMany({
        orderBy: { id: 'asc' },
        include: { records: { orderBy: { id: 'asc' } } },
      }),
      staffDays: await tx.staffAttendanceDay.findMany({ orderBy: { id: 'asc' } }),
      // Ids only: the SMS worker may still be updating their status.
      smsLogs: (await tx.smsLog.findMany({ orderBy: { id: 'asc' }, select: { id: true } })).map(
        (r) => r.id,
      ),
      audit: (await tx.auditLog.findMany({ orderBy: { id: 'asc' }, select: { id: true } })).map(
        (r) => r.id,
      ),
    }));

  it('the scheduler runs daily at 00:40 in Dhaka', async () => {
    // The harness removes the schedulers (no real-time runs in tests): register them again.
    await processor.onModuleInit();
    expect(await ingest.queue.getJobScheduler(EXPIRE_PUNCHES_JOB)).toMatchObject({
      name: EXPIRE_PUNCHES_JOB,
      pattern: '40 0 * * *',
      tz: 'Asia/Dhaka',
      template: { opts: { removeOnComplete: true, removeOnFail: 50 } },
    });
    await ingest.queue.removeJobScheduler(EXPIRE_PUNCHES_JOB);
    await ingest.queue.removeJobScheduler(DEVICES_TICK_JOB);
  });

  it("deletes each institute's punches past its own retention, in its own context; registers, records, staff days, SMS logs and the audit log stay", async () => {
    // Registered 800 days ago; the first contact, within a day of that, trusts the address the
    // reader uses from then on.
    clock.set(dhaka(day(-800), '08:00:00'));
    const school = async (punchRetentionDays: number) => {
      const s = await f.institute({ punchRetentionDays, entrySmsEnabled: true });
      const teacher = await f.staff(s.tenantId, ['TEACHER']);
      await f.map(s.tenantId, [
        { deviceUserId: '101', studentId: s.a[0]!.id },
        { deviceUserId: '9001', staffUserId: teacher },
      ]);
      const reader = f.sim(s.device.serialNo);
      expect((await reader.handshake()).status).toBe(200);
      return { ...s, reader };
    };
    const a = await school(30);
    const b = await school(730);
    for (const n of HISTORY) {
      clock.set(dhaka(day(n), '08:00:00'));
      for (const s of [a, b]) {
        await f.upload(s.reader, day(n), [
          ['101', '07:55:00'],
          ['9001', '07:58:00'],
        ]);
      }
      for (const s of [a, b]) await f.settled(s.tenantId);
    }
    for (const s of [a, b]) {
      await f.deviceRegister(s, day(-40), [
        { status: 'PRESENT' },
        { status: 'ABSENT' },
        { status: 'ABSENT' },
      ]);
    }
    const before = { a: await keptRows(a.tenantId), b: await keptRows(b.tenantId) };
    for (const rows of [before.a, before.b]) {
      expect(rows.registers).toHaveLength(1);
      expect(rows.registers[0]!.records).toHaveLength(3);
      expect(rows.staffDays).toHaveLength(HISTORY.length);
      expect(rows.smsLogs.length).toBeGreaterThan(0);
      expect(rows.audit.length).toBeGreaterThan(0);
    }
    expect(await punchDays(a.tenantId)).toEqual(twice(HISTORY));

    clock.set(dhaka(TODAY, '00:40:00'));
    // One chunk: at most `limit` punches, the oldest first.
    expect(await runner.run(a.tenantId, () => retention.deletePunches(1))).toBe(1);
    expect(await punchDays(a.tenantId)).toEqual([day(-731), ...twice(HISTORY.slice(1))]);

    // A's run (30 days): only punches before TODAY − 30 go, and only A's.
    await processor.expire(a.tenantId);
    expect(await punchDays(a.tenantId)).toEqual(twice([-30, -10]));
    expect(await punchDays(b.tenantId)).toEqual(twice(HISTORY));

    // The job (B: 730 days): punches before TODAY − 730 go, nothing newer.
    await list(a.tenantId, b.tenantId);
    await runJob();
    expect(await punchDays(a.tenantId)).toEqual(twice([-30, -10]));
    expect(await punchDays(b.tenantId)).toEqual(twice(HISTORY.slice(1)));

    // Attendance made from the deleted punches stays.
    expect(await keptRows(a.tenantId)).toEqual(before.a);
    expect(await keptRows(b.tenantId)).toEqual(before.b);
  });

  it('commands: old failed, cancelled and superseded done ones go; the latest done per device and ID and waiting ones stay, however old', async () => {
    const s = await f.institute();
    const one = s.device.id;
    const two = (await f.addDevice(s.tenantId)).id;
    const ago = (days: number) => new Date(clock.now().getTime() - days * DAY_MS);
    // In queue order (seq), on device one unless `on2`; `days` since the last change. A device's
    // answer sets done_at (`doneDays` when it came later), and the app never touches updated_at.
    const rows: {
      pin: string;
      status: 'PENDING' | 'SENT' | 'DONE' | 'FAILED' | 'CANCELLED';
      days: number;
      kept: boolean;
      doneDays?: number;
      on2?: true;
      removal?: true;
    }[] = [
      { pin: '101', status: 'DONE', days: 120, kept: false }, // a later DONE supersedes it
      { pin: '101', status: 'DONE', days: 100, kept: true }, // the latest DONE, however old
      { pin: '101', status: 'FAILED', days: 95, kept: false },
      { pin: '102', status: 'CANCELLED', days: 91, kept: false },
      { pin: '103', status: 'PENDING', days: 200, kept: true },
      { pin: '103', status: 'SENT', days: 200, kept: true },
      { pin: '104', status: 'DONE', days: 100, kept: true }, // only a waiting one after it
      { pin: '104', status: 'PENDING', days: 100, kept: true },
      { pin: '105', status: 'DONE', days: 100, kept: true }, // the later DONE is on device two
      { pin: '105', status: 'DONE', days: 95, kept: true, on2: true },
      { pin: '106', status: 'FAILED', days: 100, doneDays: 5, kept: true }, // failed lately
      { pin: '107', status: 'DONE', days: 60, kept: true }, // superseded, not 90 days old
      { pin: '107', status: 'DONE', days: 30, kept: true },
      { pin: '108', status: 'FAILED', days: 89, kept: true },
      { pin: '109', status: 'DONE', days: 150, kept: false }, // added, then removed:
      { pin: '109', status: 'DONE', days: 100, kept: true, removal: true }, // the latest DONE
      { pin: '110', status: 'DONE', days: 120, kept: false }, // superseded by a young DONE only
      { pin: '110', status: 'DONE', days: 10, kept: true },
    ];
    const label = (i: number) => `#${i} ${rows[i]!.pin} ${rows[i]!.status} ${rows[i]!.days}d`;
    const index = new Map<string, number>();
    await f.inTenant(s.tenantId, async (tx) => {
      for (const [i, r] of rows.entries()) {
        const answered = r.status === 'DONE' || r.status === 'FAILED';
        const { id } = await tx.deviceCommand.create({
          data: {
            tenantId: s.tenantId,
            deviceId: r.on2 ? two : one,
            kind: r.removal ? 'USER_DELETE' : 'USER_UPSERT',
            deviceUserId: r.pin,
            payload: r.removal
              ? `DATA DELETE USERINFO PIN=${r.pin}`
              : `DATA UPDATE USERINFO PIN=${r.pin}\tName=Test`,
            status: r.status,
            sentAt: r.status === 'PENDING' ? null : ago(r.days),
            doneAt: answered ? ago(r.doneDays ?? r.days) : null,
            createdAt: ago(r.days),
            updatedAt: ago(r.days),
          },
          select: { id: true },
        });
        index.set(id, i);
      }
    });

    await processor.expire(s.tenantId);
    const left = await f.inTenant(s.tenantId, (tx) =>
      tx.deviceCommand.findMany({ orderBy: { seq: 'asc' }, select: { id: true } }),
    );
    expect(left.map((c) => label(index.get(c.id)!))).toEqual(
      [...rows.keys()].filter((i) => rows[i]!.kept).map(label),
    );
  });

  it(`deletes ${RETENTION_CHUNK} rows per transaction until a chunk deletes fewer`, async () => {
    const t = await createTenant(h, { modules: ['ATTENDANCE'] });
    const punches = vi
      .spyOn(retention, 'deletePunches')
      .mockResolvedValueOnce(RETENTION_CHUNK)
      .mockResolvedValueOnce(RETENTION_CHUNK)
      .mockResolvedValueOnce(12);
    const commands = vi
      .spyOn(retention, 'deleteCommands')
      .mockResolvedValueOnce(RETENTION_CHUNK)
      .mockResolvedValueOnce(0);
    const runs = vi.spyOn(runner, 'run');
    const info = vi.spyOn(Logger.prototype, 'log');

    await processor.expire(t.id);
    expect(punches.mock.calls).toEqual([[RETENTION_CHUNK], [RETENTION_CHUNK], [RETENTION_CHUNK]]);
    expect(commands.mock.calls).toEqual([[RETENTION_CHUNK], [RETENTION_CHUNK]]);
    // Each chunk in its own transaction, in the institute's context.
    expect(runs.mock.calls.map((c) => c[0])).toEqual(Array(5).fill(t.id));
    // Counts only, added up over the chunks.
    expect(info.mock.calls.map((c) => String(c[0]))).toContain(
      `Retention deleted 10012 punches and 5000 device commands of tenant ${t.id}`,
    );
  });

  it('visits every listed institute, ATTENDANCE on or not; one failing stops none of the rest, stays listed, and is logged by the error name only', async () => {
    const broken = await createTenant(h, { modules: ['ATTENDANCE'] });
    const off = await createTenant(h, { modules: [] });
    const fine = await createTenant(h, { modules: ['ATTENDANCE'] });
    const context = h.app.get(RequestContext);
    const real = retention.deletePunches.bind(retention);
    vi.spyOn(retention, 'deletePunches').mockImplementation(async (limit) => {
      if (context.requireTenantId() === broken.id) throw new Error('a row value');
      return real(limit);
    });
    const finished: string[] = [];
    const realCommands = retention.deleteCommands.bind(retention);
    vi.spyOn(retention, 'deleteCommands').mockImplementation(async (limit) => {
      finished.push(context.requireTenantId());
      return realCommands(limit);
    });
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await list(broken.id, off.id, fine.id);

    await runJob();
    expect(finished).toEqual(expect.arrayContaining([off.id, fine.id]));
    expect(finished).not.toContain(broken.id);
    const lines = errors.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain(`Device retention failed for ${broken.id}: Error`);
    expect(lines.join('\n')).not.toContain('a row value');
    expect(await h.redis.zscore(DEVICES_TENANTS_KEY, broken.id)).not.toBeNull();
  });

  it('the database refuses the app deleting a punch from the last 30 days (policy retention_only)', async () => {
    // The policy counts from the database's own date, so this test follows the real one.
    const today: IsoDate = todayIn('Asia/Dhaka', new Date());
    clock.set(dhaka(addDays(today, -40), '07:00:00'));
    const s = await f.institute();
    const reader = f.sim(s.device.serialNo);
    for (const n of [-40, -10]) {
      clock.set(dhaka(addDays(today, n), '08:01:00'));
      await f.upload(reader, addDays(today, n), [['101', '07:50:00']]);
      await f.settled(s.tenantId);
    }
    const [old, recent] = await f.punches(s.tenantId);
    expect([old, recent].map((p) => dateFromDb(p!.localDate))).toEqual([
      addDays(today, -40),
      addDays(today, -10),
    ]);
    const remove = (id: string) =>
      f.inTenant(s.tenantId, (tx) => tx.devicePunch.deleteMany({ where: { id } }));

    expect((await remove(recent!.id)).count).toBe(0);
    expect((await remove(old!.id)).count).toBe(1);
    expect((await f.punches(s.tenantId)).map((p) => p.id)).toEqual([recent!.id]);
  });
});

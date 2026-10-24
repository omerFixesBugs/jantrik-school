import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { formatWithOptions } from 'node:util';
import { Logger } from '@nestjs/common';
import { withTenant, type PrismaClient, type TenantTx } from '@jantrik/db';
import { ZkDeviceSimulator, type SimulatorOptions } from '@jantrik/device-sim';
import type { Redis } from 'ioredis';
import { PROCESS_PUNCHES_JOB, processPunchesJobId } from '../src/devices/devices.constants.js';
import { INGEST_SERVER_LIMITS } from '../src/ingest/ingest.bootstrap.js';
import { IngestService } from '../src/ingest/ingest.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import { Db } from '../src/tenancy/db.service.js';
import { FakeClock } from './support/clock.js';
import { createTenant, randomIp } from './support/harness.js';
import { createIngestHarness, ingestHttp, type IngestHarness } from './support/ingest.js';
import { ownerClient } from './support/platform.js';

// The ZKTeco device receiver (src/ingest): its own Nest app and database login, plain HTTP, no
// login. Devices are driven with @jantrik/device-sim; time comes from a FakeClock.

/** A serial number no earlier run has used: serials are unique across institutes. */
const newSerial = () => `T${randomUUID().replace(/-/g, '').slice(0, 15).toUpperCase()}`;
/** A Dhaka wall-clock time on 2026-10-20 as an instant. */
const at = (time: string) => new Date(`2026-10-20T${time}+06:00`);

/** `h` is the harness; `now` the receiver's clock (a FakeClock, or the real one). */
function setup(h: () => IngestHarness, now: () => Date) {
  const institute = (opts: { modules?: 'ATTENDANCE'[] } = {}) =>
    createTenant(h(), { modules: opts.modules ?? ['ATTENDANCE'] });
  /**
   * A device registered an hour ago by default: its first contact then comes within 24 hours of
   * registration, so the address it first calls from is trusted (later first contacts are not).
   */
  const addDevice = (
    tenantId: string,
    opts: { isActive?: boolean; registeredAgoMs?: number } = {},
  ) =>
    withTenant(h().prisma, tenantId, (tx) =>
      tx.attendanceDevice.create({
        data: {
          tenantId,
          serialNo: newSerial(),
          name: 'Main gate',
          direction: 'BOTH',
          isActive: opts.isActive ?? true,
          createdAt: new Date(now().getTime() - (opts.registeredAgoMs ?? 3600_000)),
        },
      }),
    );
  /** An admin trusting an address the device called from, as the app role does it. */
  const trustAddress = (tenantId: string, deviceId: string, ip: string) =>
    withTenant(h().prisma, tenantId, (tx) =>
      tx.deviceSourceIp.updateMany({
        where: { deviceId, ip, trustedAt: null },
        data: { trustedAt: now() },
      }),
    );
  const sim = (sn: string, opts: Partial<SimulatorOptions> = {}) =>
    new ZkDeviceSimulator({ baseUrl: h().baseUrl, sn, forwardedFor: randomIp(), ...opts });
  return { institute, addDevice, trustAddress, sim };
}

describe('device receiver', () => {
  const T0 = at('08:00:00');
  const clock = new FakeClock(T0);
  let h: IngestHarness;
  const { institute, addDevice, trustAddress, sim } = setup(
    () => h,
    () => clock.now(),
  );

  beforeAll(async () => {
    h = await createIngestHarness({ clock });
  });
  afterAll(async () => {
    await h.queue.obliterate({ force: true });
    await h.close();
  });
  beforeEach(() => clock.set(T0));
  afterEach(() => vi.restoreAllMocks());

  const inTenant = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) =>
    withTenant(h.prisma, tenantId, fn);
  const punchesOf = (tenantId: string, deviceId: string) =>
    inTenant(tenantId, (tx) =>
      tx.devicePunch.findMany({
        where: { deviceId },
        orderBy: [{ deviceTime: 'asc' }, { deviceUserId: 'asc' }],
      }),
    );
  const deviceRow = (tenantId: string, id: string) =>
    inTenant(tenantId, (tx) => tx.attendanceDevice.findUniqueOrThrow({ where: { id } }));
  const refusedList = async () =>
    (await h.redis.lrange('ingest:refused', 0, -1)).map((e) => JSON.parse(e) as unknown);
  const refusalLines = (warn: { mock: { calls: unknown[][] } }, sn: string) =>
    warn.mock.calls.map((c) => String(c[0])).filter((line) => line.includes(sn));

  describe('refusals', () => {
    it('an unknown serial gets 403 and one log line per 10 minutes; ingest:refused keeps each', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const sn = newSerial();
      const ip = randomIp();
      const device = sim(sn, { forwardedFor: ip });
      expect(await device.handshake()).toEqual({ status: 403, body: 'ERROR' });
      // An upload is refused the same way, its body unread.
      expect(await device.punch('101', { at: T0 })).toEqual({ status: 403, body: 'ERROR' });
      expect(refusalLines(warn, sn)).toEqual([`device refused: ${sn} (UNKNOWN) from ${ip}`]);
      const ttl = await h.redis.ttl(`ingest:refused-log:${sn}`);
      expect(ttl).toBeGreaterThan(590);
      expect(ttl).toBeLessThanOrEqual(600);
      const entry = { sn, reason: 'UNKNOWN', ip, at: T0.toISOString() };
      expect((await refusedList()).filter((e) => (e as { sn: string }).sn === sn)).toEqual([
        entry,
        entry,
      ]);
      expect(await h.redis.get(`rl:ingest-refused-ip:${ip}`)).toBe('2');
    });

    it('logs the reason: an inactive device, an institute without attendance', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const t = await institute();
      const inactive = await addDevice(t.id, { isActive: false });
      const off = await addDevice((await institute({ modules: [] })).id);
      const ip = randomIp();
      for (const [dev, reason] of [
        [inactive, 'INACTIVE'],
        [off, 'MODULE_OFF'],
      ] as const) {
        expect(await sim(dev.serialNo, { forwardedFor: ip }).ping()).toEqual({
          status: 403,
          body: 'ERROR',
        });
        expect(refusalLines(warn, dev.serialNo)).toEqual([
          `device refused: ${dev.serialNo} (${reason}) from ${ip}`,
        ]);
      }
      // Nothing was written: the devices were never seen.
      expect((await deviceRow(t.id, inactive.id)).lastSeenAt).toBeNull();
    });

    it('a direct IPv4 client is logged and counted as a.b.c.d, not ::ffff:a.b.c.d', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const sn = newSerial();
      const res = await fetch(`${h.baseUrl}/iclock/ping?SN=${sn}`);
      expect(res.status).toBe(403);
      expect(refusalLines(warn, sn)).toEqual([`device refused: ${sn} (UNKNOWN) from 127.0.0.1`]);
    });

    it('an invalid serial gets 400 without a database call', async () => {
      const query = vi.spyOn(h.ingestDb, '$queryRaw');
      const ip = randomIp();
      for (const path of [
        '/iclock/cdata?SN=AB-12345&options=all',
        '/iclock/getrequest?SN=AB12',
        `/iclock/ping?SN=${'A'.repeat(33)}`,
        '/iclock/ping',
        '/iclock/ping?SN=ABC12345&SN=ABC12346',
      ]) {
        const res = await ingestHttp(h).get(path).set('X-Forwarded-For', ip);
        expect([res.status, res.text]).toEqual([400, 'ERROR']);
      }
      expect(query).not.toHaveBeenCalled();
    });
  });

  it('runs with its own server limits and none of the API database access in its container', () => {
    const server = h.app.getHttpServer() as Server;
    expect({
      requestTimeout: server.requestTimeout,
      headersTimeout: server.headersTimeout,
      keepAliveTimeout: server.keepAliveTimeout,
      maxConnections: server.maxConnections,
    }).toEqual(INGEST_SERVER_LIMITS);
    // Not even through a module imported along the way.
    for (const token of [PrismaService, Db, TenantJobRunner]) {
      expect(() => h.app.get(token, { strict: false })).toThrow();
    }
  });

  it('answers plain text with a Content-Length, no caching and a Date; 404 elsewhere', async () => {
    const t = await institute();
    const dev = await addDevice(t.id);
    const res = await fetch(`${h.baseUrl}/iclock/ping?SN=${dev.serialNo}`, {
      headers: { 'X-Forwarded-For': randomIp() },
    });
    expect([res.status, await res.text()]).toEqual([200, 'OK']);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'text/plain; charset=utf-8',
      'content-length': '2',
      'cache-control': 'no-store',
      pragma: 'no-cache',
    });
    expect(res.headers.get('date')).toMatch(/ GMT$/);
    for (const header of ['transfer-encoding', 'x-powered-by', 'etag', 'set-cookie']) {
      expect(res.headers.get(header)).toBeNull();
    }
    for (const [method, path] of [
      ['GET', '/iclock/registry'],
      ['POST', '/iclock/getrequest'],
      ['GET', '/health'],
      ['GET', '/'],
    ] as const) {
      const other = await fetch(`${h.baseUrl}${path}?SN=${dev.serialNo}`, { method });
      expect([other.status, await other.text()]).toEqual([404, 'Not Found']);
      expect(other.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    }
  });

  it('the handshake: options, the stored stamp after an upload, the old names without pushver', async () => {
    const t = await institute();
    const dev = await addDevice(t.id);
    const device = sim(dev.serialNo);
    const options = (stamp: string) =>
      [
        `GET OPTION FROM: ${dev.serialNo}`,
        `ATTLOGStamp=${stamp}`,
        'OPERLOGStamp=9999',
        'ATTPHOTOStamp=9999',
        'ErrorDelay=60',
        'Delay=30',
        'TransTimes=00:00;14:05',
        'TransInterval=1',
        'TransFlag=TransData AttLog',
        'TimeZone=6',
        'Realtime=1',
        'Encrypt=None',
      ].join('\n') + '\n';
    expect(await device.handshake()).toEqual({ status: 200, body: options('None') });
    expect((await deviceRow(t.id, dev.id)).pushVersion).toBe('2.4.1');

    expect(await device.punch('101', { at: at('07:59:00') })).toEqual({
      status: 200,
      body: 'OK: 1',
    });
    expect(await device.handshake()).toEqual({ status: 200, body: options('1') });

    const legacy = sim(dev.serialNo, { pushVersion: null });
    expect((await legacy.handshake()).status).toBe(200);
    expect(legacy.options).toMatchObject({ Stamp: '1', OpStamp: '9999', PhotoStamp: '9999' });
    expect(legacy.options).not.toHaveProperty('ATTLOGStamp');

    // A pushver that is not a version is not stored; other reads of cdata are just `OK`.
    const ip = randomIp();
    await ingestHttp(h)
      .get(`/iclock/cdata?SN=${dev.serialNo}&options=all&pushver=2.4%0Ax`)
      .set('X-Forwarded-For', ip)
      .expect(200);
    expect((await deviceRow(t.id, dev.id)).pushVersion).toBe('2.4.1');
    await ingestHttp(h)
      .get(`/iclock/cdata?SN=${dev.serialNo}&table=RemoteAtt&PIN=1`)
      .set('X-Forwarded-For', ip)
      .expect(200, 'OK');
  });

  describe('ATTLOG', () => {
    it('stores four fields of each punch and queues process-punches with { tenantId } only', async () => {
      const t = await institute();
      const dev = await addDevice(t.id);
      const ip = randomIp();
      const device = sim(dev.serialNo, { forwardedFor: ip });
      const res = await device.uploadAttlog(
        [
          device.attlogLine('101', at('07:55:00')),
          device.attlogLine('102', at('07:58:30'), { out: true, verify: 15 }),
          'not a punch',
          '',
        ],
        { crlf: true },
      );
      // Every non-blank line counts, the rejected one too.
      expect(res).toEqual({ status: 200, body: 'OK: 3' });
      const rows = await punchesOf(t.id, dev.id);
      expect(
        rows.map((r) => ({
          pin: r.deviceUserId,
          deviceTime: r.deviceTime.toISOString(),
          punchedAt: r.punchedAt.toISOString(),
          localDate: r.localDate.toISOString().slice(0, 10),
          receivedAt: r.receivedAt.toISOString(),
          verifyType: r.verifyType,
          state: r.state,
          direction: r.direction,
          flags: r.flags,
          sourceIp: r.sourceIp,
        })),
      ).toEqual([
        {
          pin: '101',
          deviceTime: '2026-10-20T07:55:00.000Z',
          punchedAt: '2026-10-20T01:55:00.000Z',
          localDate: '2026-10-20',
          receivedAt: T0.toISOString(),
          verifyType: 1,
          state: 0,
          direction: 'IN',
          flags: [],
          sourceIp: null,
        },
        {
          pin: '102',
          deviceTime: '2026-10-20T07:58:30.000Z',
          punchedAt: '2026-10-20T01:58:30.000Z',
          localDate: '2026-10-20',
          receivedAt: T0.toISOString(),
          verifyType: 15,
          state: 1,
          direction: 'OUT',
          flags: [],
          sourceIp: null,
        },
      ]);
      expect(await deviceRow(t.id, dev.id)).toMatchObject({
        lastSeenAt: T0,
        lastIp: ip,
        attlogStamp: '1',
        lastPunchAt: at('07:58:30'),
      });

      const job = await h.queue.getJob(processPunchesJobId(t.id));
      expect(job?.name).toBe(PROCESS_PUNCHES_JOB);
      expect(job?.data).toStrictEqual({ tenantId: t.id });
      expect(job?.opts).toMatchObject({ delay: 1000, removeOnComplete: true, removeOnFail: 50 });
    });

    it('the same batch twice stores one row each and queues nothing more', async () => {
      const t = await institute();
      const dev = await addDevice(t.id);
      const device = sim(dev.serialNo);
      const lines = [
        device.attlogLine('201', at('07:50:00')),
        device.attlogLine('202', at('07:51:00')),
      ];
      expect(await device.uploadAttlog(lines)).toEqual({ status: 200, body: 'OK: 2' });
      const add = vi.spyOn(h.queue, 'add');
      expect(await device.uploadAttlog(lines)).toEqual({ status: 200, body: 'OK: 2' });
      expect(add).not.toHaveBeenCalled();
      expect(await punchesOf(t.id, dev.id)).toHaveLength(2);
    });

    it('413 for an upload over the byte limit and for 10 001 lines; nothing is stored', async () => {
      const t = await institute();
      const dev = await addDevice(t.id);
      const device = sim(dev.serialNo);
      // 9000 lines of about 90 bytes: over 512 KB, under 10 000 lines.
      const big = Array.from(
        { length: 9000 },
        (_, i) => `${1000 + i}\t2026-10-20 07:00:00\t0\t1\t${'9'.repeat(60)}`,
      );
      expect(await device.uploadAttlog(big)).toEqual({ status: 413, body: 'ERROR' });
      const many = Array.from(
        { length: 10_001 },
        (_, i) => `${100_000 + i}\t2026-10-20 07:00:00\t0\t1`,
      );
      expect(await device.uploadAttlog(many)).toEqual({ status: 413, body: 'ERROR' });
      expect(await punchesOf(t.id, dev.id)).toEqual([]);
      // The connection and the device are fine afterwards.
      expect(await device.ping()).toEqual({ status: 200, body: 'OK' });
    });

    it('takes the largest upload, 10 000 lines, in one request (seconds in the database)', async () => {
      const t = await institute();
      // 200 a minute stay under the highest cap, so none is held or dropped.
      await inTenant(t.id, (tx) =>
        tx.attendanceSettings.update({
          where: { tenantId: t.id },
          data: { deviceMaxPunchesPerMinute: 240 },
        }),
      );
      const dev = await addDevice(t.id);
      const device = sim(dev.serialNo);
      const start = at('06:00:00').getTime();
      const lines = Array.from({ length: 10_000 }, (_, i) =>
        device.attlogLine(String(100_000 + i), new Date(start + Math.floor(i / 200) * 60_000)),
      );
      expect(await device.uploadAttlog(lines)).toEqual({ status: 200, body: 'OK: 10000' });
      expect(
        await inTenant(t.id, (tx) => tx.devicePunch.count({ where: { deviceId: dev.id } })),
      ).toBe(10_000);
    });

    it('a second source address flags NEW_IP; ::ffff:a.b.c.d is the same address as a.b.c.d', async () => {
      const t = await institute();
      const dev = await addDevice(t.id);
      const first = randomIp();
      const second = randomIp();
      const mapped = sim(dev.serialNo, { forwardedFor: `::ffff:${first}` });
      const plain = sim(dev.serialNo, { forwardedFor: first });
      const other = sim(dev.serialNo, { forwardedFor: second });
      expect((await mapped.punch('301', { at: at('07:40:00') })).body).toBe('OK: 1');
      expect((await plain.punch('302', { at: at('07:41:00') })).body).toBe('OK: 1');
      expect((await other.punch('303', { at: at('07:42:00') })).body).toBe('OK: 1');

      const rows = await punchesOf(t.id, dev.id);
      expect(rows.map((r) => [r.deviceUserId, r.flags, r.sourceIp])).toEqual([
        ['301', [], null],
        ['302', [], null],
        ['303', ['NEW_IP'], second],
      ]);
      const addresses = await inTenant(t.id, (tx) =>
        // The clock stands still here, so both were first seen at the same instant.
        tx.deviceSourceIp.findMany({
          where: { deviceId: dev.id },
          orderBy: { punchCount: 'desc' },
        }),
      );
      expect(addresses.map((a) => [a.ip, a.punchCount, a.trustedAt !== null])).toEqual([
        [first, 2, true],
        [second, 1, false],
      ]);
      // One rate-limit bucket for the address, whichever way it was written.
      expect(await h.redis.get(`rl:ingest-ip:${first}`)).toBe('2');
      expect(await h.redis.exists(`rl:ingest-ip:::ffff:${first}`)).toBe(0);
    });

    it('flags punches outside the institute hours (05:00-20:00)', async () => {
      const t = await institute();
      const dev = await addDevice(t.id);
      const device = sim(dev.serialNo);
      clock.set(at('21:30:00'));
      const times = ['04:59:59', '05:00:00', '20:00:00', '20:00:01'];
      const res = await device.uploadAttlog(
        times.map((time, i) => device.attlogLine(String(401 + i), at(time))),
      );
      expect(res.body).toBe('OK: 4');
      expect((await punchesOf(t.id, dev.id)).map((r) => r.flags)).toEqual([
        ['OUTSIDE_HOURS'],
        [],
        [],
        ['OUTSIDE_HOURS'],
      ]);
    });

    it('holds punches over the per-minute cap as BURST and drops them beyond 5 times it', async () => {
      const t = await institute();
      await inTenant(t.id, (tx) =>
        tx.attendanceSettings.update({
          where: { tenantId: t.id },
          data: { deviceMaxPunchesPerMinute: 10 },
        }),
      );
      const dev = await addDevice(t.id);
      const device = sim(dev.serialNo);
      clock.set(at('08:01:00'));
      const lines = Array.from({ length: 60 }, (_, i) =>
        device.attlogLine(String(1000 + i), new Date(T0.getTime() + i * 1000)),
      );
      expect(await device.uploadAttlog(lines)).toEqual({ status: 200, body: 'OK: 60' });
      const rows = await punchesOf(t.id, dev.id);
      expect(rows).toHaveLength(50);
      expect(rows.slice(0, 10).every((r) => r.flags.length === 0)).toBe(true);
      expect(rows.slice(10).every((r) => r.flags.join() === 'BURST')).toBe(true);
      expect(await deviceRow(t.id, dev.id)).toMatchObject({
        lastFloodAt: at('08:01:00'),
        lastFloodDropped: 10,
      });
    });

    it("institute A's serial writes only A's rows; B sees none and gets no job", async () => {
      const a = await institute();
      const b = await institute();
      const devA = await addDevice(a.id);
      expect((await sim(devA.serialNo).punch('501', { at: at('07:30:00') })).body).toBe('OK: 1');
      expect(await punchesOf(a.id, devA.id)).toHaveLength(1);
      expect(await inTenant(b.id, (tx) => tx.devicePunch.count())).toBe(0);
      expect(
        await inTenant(b.id, (tx) => tx.devicePunch.count({ where: { deviceId: devA.id } })),
      ).toBe(0);
      expect((await h.queue.getJob(processPunchesJobId(a.id)))?.data).toStrictEqual({
        tenantId: a.id,
      });
      expect(await h.queue.getJob(processPunchesJobId(b.id))).toBeUndefined();
    });

    it('learns a clock 7 minutes fast from 3 online uploads, then corrects the next punch', async () => {
      const t = await institute();
      const dev = await addDevice(t.id);
      const device = sim(dev.serialNo);
      await device.handshake();
      const fast = () => new Date(clock.now().getTime() + 420_000);
      for (const pin of ['601', '602', '603']) {
        clock.advance(30_000);
        expect((await device.punch(pin, { at: fast() })).body).toBe('OK: 1');
      }
      expect(await deviceRow(t.id, dev.id)).toMatchObject({
        clockOffsetSec: 420,
        clockSamples: [420, 420, 420],
      });
      clock.advance(30_000);
      expect((await device.punch('604', { at: fast() })).body).toBe('OK: 1');
      const rows = await punchesOf(t.id, dev.id);
      // Before the offset was known, 7 minutes ahead is "in the future" (more than 5 minutes).
      expect(rows.map((r) => [r.deviceUserId, r.flags])).toEqual([
        ['601', ['CLOCK_FUTURE']],
        ['602', ['CLOCK_FUTURE']],
        ['603', ['CLOCK_FUTURE']],
        ['604', ['CLOCK_CORRECTED']],
      ]);
      expect(rows[3]!.punchedAt).toEqual(clock.now());
    });

    it('a punch an hour in the future gets CLOCK_FUTURE and the time it was received', async () => {
      const t = await institute();
      const dev = await addDevice(t.id);
      expect((await sim(dev.serialNo).punch('701', { at: at('09:00:00') })).body).toBe('OK: 1');
      const [row] = await punchesOf(t.id, dev.id);
      expect(row).toMatchObject({ flags: ['CLOCK_FUTURE'], punchedAt: T0, receivedAt: T0 });
    });
  });

  it('commands: delivered once, again after 5 minutes, DONE on Return=0, FAILED otherwise', async () => {
    const t = await institute();
    const dev = await addDevice(t.id);
    const [c1, c2] = await inTenant(t.id, async (tx) => {
      const out = [];
      for (const pin of ['801', '802']) {
        out.push(
          await tx.deviceCommand.create({
            data: {
              tenantId: t.id,
              deviceId: dev.id,
              kind: 'USER_DELETE',
              deviceUserId: pin,
              payload: `DATA DELETE USERINFO PIN=${pin}`,
            },
          }),
        );
      }
      return out;
    });
    // The first address a device ever calls from is the one it trusts.
    const ip = randomIp();
    const stranger = randomIp();
    const poll = async (from: string) =>
      (
        await ingestHttp(h)
          .get(`/iclock/getrequest?SN=${dev.serialNo}`)
          .set('X-Forwarded-For', from)
          .expect(200)
      ).text;
    const answer = (from: string) =>
      ingestHttp(h)
        .post(`/iclock/devicecmd?SN=${dev.serialNo}`)
        .set('X-Forwarded-For', from)
        .set('Content-Type', 'text/plain')
        .send(`ID=${c1!.seq}&Return=0&CMD=DATA\nID=${c2!.seq}&Return=-1002&CMD=DATA\n`)
        .expect(200, 'OK');
    const states = async () =>
      (
        await inTenant(t.id, (tx) =>
          tx.deviceCommand.findMany({ where: { deviceId: dev.id }, orderBy: { seq: 'asc' } }),
        )
      ).map((c) => [c.status, c.returnCode, c.attempts]);
    const lines =
      `C:${c1!.seq}:DATA DELETE USERINFO PIN=801\n` + `C:${c2!.seq}:DATA DELETE USERINFO PIN=802\n`;
    expect(await poll(ip)).toBe(lines);
    expect(await poll(ip)).toBe('OK');
    clock.advance(5 * 60_000 + 1000);
    // Another address knowing the serial gets nothing and cannot answer for the device.
    expect(await poll(stranger)).toBe('OK');
    await answer(stranger);
    expect(await states()).toEqual([
      ['SENT', null, 1],
      ['SENT', null, 1],
    ]);
    expect(await poll(ip)).toBe(lines);

    await answer(ip);
    expect(await states()).toEqual([
      ['DONE', 0, 2],
      ['FAILED', -1002, 2],
    ]);
    expect(await poll(ip)).toBe('OK');

    // From INFO only the firmware and the user count are kept (from any address).
    await sim(dev.serialNo, { forwardedFor: stranger }).poll(true);
    expect(await deviceRow(t.id, dev.id)).toMatchObject({
      firmware: 'Ver 8.0.4-sim',
      userCount: 0,
    });
  });

  describe('the first address is trusted only within 24 hours of registration', () => {
    const queueUpsert = (tenantId: string, deviceId: string, pin: string) =>
      inTenant(tenantId, (tx) =>
        tx.deviceCommand.create({
          data: {
            tenantId,
            deviceId,
            kind: 'USER_UPSERT',
            deviceUserId: pin,
            payload: `DATA UPDATE USERINFO PIN=${pin}\tName=Rahim`,
          },
        }),
      );
    const commandOf = async (tenantId: string, id: string) =>
      inTenant(tenantId, (tx) => tx.deviceCommand.findUniqueOrThrow({ where: { id } }));

    it('registered 23 hours ago: its first address is trusted, so commands flow and no NEW_IP', async () => {
      const t = await institute();
      const dev = await addDevice(t.id, { registeredAgoMs: 23 * 3600_000 });
      const command = await queueUpsert(t.id, dev.id, '811');
      const device = sim(dev.serialNo);
      expect((await device.punch('811', { at: at('07:59:00') })).body).toBe('OK: 1');
      expect((await device.poll()).commands.map((c) => c.returnCode)).toEqual([0]);
      expect(await commandOf(t.id, command.id)).toMatchObject({ status: 'DONE', attempts: 1 });
      const [row] = await punchesOf(t.id, dev.id);
      expect(row).toMatchObject({ flags: [], sourceIp: null });
    });

    it('registered 2 days ago: NEW_IP and no commands until an admin trusts the address', async () => {
      const t = await institute();
      const dev = await addDevice(t.id, { registeredAgoMs: 2 * 24 * 3600_000 });
      const command = await queueUpsert(t.id, dev.id, '812');
      const ip = randomIp();
      const device = sim(dev.serialNo, { forwardedFor: ip });
      expect((await device.punch('812', { at: at('07:58:00') })).body).toBe('OK: 1');
      expect(await device.poll()).toEqual({ commands: [] });
      expect(await commandOf(t.id, command.id)).toMatchObject({ status: 'PENDING', attempts: 0 });

      await trustAddress(t.id, dev.id, ip);
      expect((await device.poll()).commands.map((c) => c.returnCode)).toEqual([0]);
      expect(await commandOf(t.id, command.id)).toMatchObject({ status: 'DONE', attempts: 1 });
      expect((await device.punch('812', { at: at('07:59:00') })).body).toBe('OK: 1');
      expect((await punchesOf(t.id, dev.id)).map((r) => [r.flags, r.sourceIp])).toEqual([
        [['NEW_IP'], ip],
        [[], null],
      ]);
    });
  });

  it('HEAD and other methods reach no route and no database (HEAD would take commands)', async () => {
    const t = await institute();
    const dev = await addDevice(t.id);
    await inTenant(t.id, (tx) =>
      tx.deviceCommand.create({
        data: {
          tenantId: t.id,
          deviceId: dev.id,
          kind: 'USER_DELETE',
          deviceUserId: '901',
          payload: 'DATA DELETE USERINFO PIN=901',
        },
      }),
    );
    const query = vi.spyOn(h.ingestDb, '$queryRaw');
    const ip = randomIp();
    for (const [method, path] of [
      ['HEAD', '/iclock/getrequest'],
      ['HEAD', '/iclock/cdata'],
      ['HEAD', '/iclock/ping'],
      ['OPTIONS', '/iclock/getrequest'],
      ['PUT', '/iclock/cdata'],
      ['DELETE', '/iclock/ping'],
    ] as const) {
      const res = await fetch(`${h.baseUrl}${path}?SN=${dev.serialNo}&options=all`, {
        method,
        headers: { 'X-Forwarded-For': ip },
      });
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
    expect(query).not.toHaveBeenCalled();
    const [command] = await inTenant(t.id, (tx) =>
      tx.deviceCommand.findMany({ where: { deviceId: dev.id } }),
    );
    expect(command).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect((await deviceRow(t.id, dev.id)).lastSeenAt).toBeNull();
  });

  describe('an answer before the body arrived closes the connection', () => {
    /**
     * Sends a POST announcing a 1 GiB body and keeps writing (up to 64 MB) until the server closes
     * the connection. Returns whether it did, and how much of the body the server read.
     */
    async function hugePost(path: string) {
      const server = h.app.getHttpServer() as Server;
      // The port is read on arrival: a destroyed socket no longer has it.
      const accepted: { socket: Socket; port: number | undefined }[] = [];
      const onConnection = (s: Socket) => accepted.push({ socket: s, port: s.remotePort });
      server.on('connection', onConnection);
      const url = new URL(h.baseUrl);
      const socket = connect(Number(url.port), url.hostname);
      await new Promise((resolve) => socket.once('connect', resolve));
      const localPort = socket.localPort;
      let response = '';
      let closed = false;
      socket.on('data', (d: Buffer) => (response += d.toString('latin1')));
      socket.on('error', () => undefined);
      socket.on('close', () => (closed = true));
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: receiver\r\nX-Forwarded-For: ${randomIp()}\r\n` +
          `Content-Type: text/plain\r\nContent-Length: ${2 ** 30}\r\n\r\n`,
      );
      const chunk = Buffer.alloc(64 * 1024, 'x');
      let written = 0;
      while (!closed && written < 64 * 2 ** 20) {
        written += chunk.length;
        if (!socket.write(chunk)) {
          await new Promise((resolve) => {
            socket.once('drain', resolve);
            socket.once('close', resolve);
          });
        }
      }
      socket.destroy();
      server.off('connection', onConnection);
      const ours = accepted.find((a) => a.port === localPort);
      return { closed, response, serverRead: ours?.socket.bytesRead ?? 0 };
    }

    it.each([
      ['an invalid serial (400)', '/iclock/cdata?SN=bad&table=ATTLOG', 400],
      ['an unknown serial (403)', `/iclock/cdata?SN=${newSerial()}&table=OPERLOG`, 403],
      ['an unknown route (404)', '/iclock/registry?SN=ABCDEF12', 404],
    ])('%s', async (_case, path, status) => {
      const { closed, response, serverRead } = await hugePost(path);
      expect(closed).toBe(true);
      expect(serverRead).toBeGreaterThan(0);
      // Far less than the 2 MB drain limit, let alone the gigabyte announced.
      expect(serverRead).toBeLessThan(2 * 2 ** 20);
      // When the answer arrives before the reset, it says so and closes.
      if (response) {
        expect(response).toMatch(new RegExp(`^HTTP/1\\.1 ${status} `));
        expect(response.toLowerCase()).toContain('connection: close');
      }
    });
  });

  describe('biometric data never lands anywhere', () => {
    let owner: PrismaClient;
    beforeAll(() => {
      owner = ownerClient();
    });
    afterAll(async () => {
      await owner.$disconnect();
    });

    /** `table.column` of every text-like column in public that contains one of `needles`. */
    async function findInDatabase(tx: PrismaClient | TenantTx, needles: string[]) {
      const columns = await tx.$queryRaw<{ table: string; column: string; type: string }[]>`
        SELECT c.table_name AS table, c.column_name AS column, c.data_type AS type
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'bytea',
                              'ARRAY', 'USER-DEFINED')`;
      expect(columns.length).toBeGreaterThan(100);
      const id = (name: string) => `"${name.replace(/"/g, '""')}"`;
      const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;
      const matches = (c: { column: string; type: string }) =>
        '(' +
        needles
          .map((_, i) =>
            c.type === 'bytea'
              ? `position(convert_to($${i + 1}, 'UTF8') in ${id(c.column)}) > 0`
              : `strpos(${id(c.column)}::text, $${i + 1}) > 0`,
          )
          .join(' OR ') +
        ')';
      // One scan per table (a query per column takes 25 times as long).
      const tables = new Map<string, typeof columns>();
      for (const c of columns) tables.set(c.table, [...(tables.get(c.table) ?? []), c]);
      const sql = [...tables]
        .map(([table, cols]) => {
          const labels = cols.map(
            (c) => `CASE WHEN ${matches(c)} THEN ${literal(`${table}.${c.column}`)} END`,
          );
          return (
            `SELECT f AS found FROM (SELECT ARRAY[${labels.join(', ')}] AS fs ` +
            `FROM public.${id(table)} WHERE ${cols.map(matches).join(' OR ')}) x, ` +
            `unnest(x.fs) AS f WHERE f IS NOT NULL`
          );
        })
        .join('\nUNION ALL\n');
      const rows = await tx.$queryRawUnsafe<{ found: string }[]>(sql, ...needles);
      return [...new Set(rows.map((r) => r.found))];
    }

    /**
     * Captures everything that could print until the mocks are restored: the streams, Nest's
     * Logger and console (vitest replaces console with its own, which does not write to
     * process.stdout). Each value is kept whole: objects to any depth, and Buffers and byte arrays
     * (inside objects too) also as UTF-8 text, base64 and hex, which printing would show only as
     * truncated hex.
     */
    function captureOutput(): string[] {
      const output: string[] = [];
      const textOf = (args: unknown[]) => {
        const bytes: string[] = [];
        const seen = new WeakSet<object>();
        const walk = (value: unknown): void => {
          if (value instanceof Uint8Array) {
            const b = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
            bytes.push(b.toString('utf8'), b.toString('base64'), b.toString('hex'));
          } else if (value !== null && typeof value === 'object' && !seen.has(value)) {
            seen.add(value);
            const items =
              value instanceof Map
                ? [...value.keys(), ...value.values()]
                : value instanceof Set
                  ? [...value]
                  : Object.values(value);
            items.forEach(walk);
          }
        };
        args.forEach(walk);
        return [formatWithOptions({ depth: Infinity }, ...args), ...bytes].join('\n');
      };
      for (const stream of [process.stdout, process.stderr]) {
        vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown) => {
          output.push(textOf([chunk]));
          return true;
        }) as typeof stream.write);
      }
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
        const original = Logger.prototype[level];
        vi.spyOn(Logger.prototype, level).mockImplementation(function (
          this: Logger,
          ...args: unknown[]
        ) {
          output.push(textOf(args));
          return (original as (...a: unknown[]) => void).apply(this, args);
        });
      }
      for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          output.push(textOf(args));
        });
      }
      return output;
    }

    /** Every key in the test Redis database whose name or value contains one of `needles`. */
    async function findInRedis(redis: Redis, needles: string[]) {
      const found: string[] = [];
      const has = (value: Buffer | string) => needles.some((n) => Buffer.from(value).includes(n));
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'COUNT', 1000);
        cursor = next;
        for (const key of keys) {
          const type = await redis.type(key);
          let values: (Buffer | string)[] = [];
          if (type === 'string') values = [(await redis.getBuffer(key)) ?? ''];
          else if (type === 'list') values = await redis.lrangeBuffer(key, 0, -1);
          else if (type === 'hash') {
            const hash = await redis.hgetallBuffer(key);
            values = [...Object.keys(hash), ...Object.values(hash)];
          } else if (type === 'set') values = await redis.smembersBuffer(key);
          else if (type === 'zset') values = await redis.zrangeBuffer(key, 0, -1);
          else if (type === 'stream') {
            const entries = (await redis.xrangeBuffer(key, '-', '+')) as unknown[];
            values = (entries.flat(Infinity) as unknown[]).filter(
              (v): v is Buffer | string => Buffer.isBuffer(v) || typeof v === 'string',
            );
          } else if (type !== 'none') throw new Error(`Unexpected Redis type ${type} at ${key}`);
          if (has(key) || values.some(has)) found.push(key);
        }
      } while (cursor !== '0');
      return found;
    }

    it('fingerprint, face, photo and user-info uploads are answered OK and kept nowhere', async () => {
      const SENTINEL = `ZKSENTINEL${randomUUID().replace(/-/g, '')}`;
      const needles = ['utf8', 'base64', 'hex'].map((form) =>
        Buffer.from(SENTINEL).toString(form as BufferEncoding),
      );
      const t = await institute();
      const dev = await addDevice(t.id);
      const device = sim(dev.serialNo);
      const unknown = newSerial();

      // The capture itself first: the sentinel's own bytes, logged the way a request chunk would
      // be (alone, or inside an object), are found. Then a fresh capture for the real run.
      const probe = captureOutput();
      console.log(Buffer.from(SENTINEL));
      console.log({ chunk: new Uint8Array(Buffer.from(SENTINEL)) });
      vi.restoreAllMocks();
      expect(probe).toHaveLength(2);
      for (const printed of probe) expect(printed).toContain(SENTINEL);

      const output = captureOutput();
      // Controls: leaks planted inside a request, the way a debugging line would leak a body.
      const planted = `PLANTED${randomUUID().replace(/-/g, '')}`;
      const service = h.app.get(IngestService);
      const handshake = service.handshake.bind(service);
      vi.spyOn(service, 'handshake').mockImplementation((...args) => {
        console.log({ body: { note: `${planted}-console` } });
        console.error(`${planted}-console-error`);
        console.log(Buffer.from(`${planted}-buffer`));
        console.info({ req: { chunks: [Buffer.from(`${planted}-nested-buffer`)] } });
        new Logger('Planted').debug(`${planted}-logger`);
        return handshake(...args);
      });

      expect((await device.handshake()).status).toBe(200);
      const answers = await device.sendBiometricPayloads(SENTINEL);
      expect(answers.length).toBeGreaterThanOrEqual(7);
      expect(answers.map((a) => [a.path.split('?')[0], a.status, a.body])).toEqual(
        answers.map((a) => [a.path.split('?')[0], 200, 'OK']),
      );
      // Work code and reserved fields carrying the sentinel: the punch is kept, they are not.
      const line = `${['901', '2026-10-20 07:59:00', '0', '1'].join('\t')}\t${SENTINEL}\t${SENTINEL}\t${SENTINEL}`;
      expect(await device.uploadAttlog([line])).toEqual({ status: 200, body: 'OK: 1' });
      // A refusal in the same window: proves the log capture works.
      expect((await sim(unknown).ping()).status).toBe(403);
      vi.restoreAllMocks();

      const rows = await punchesOf(t.id, dev.id);
      expect(rows.map((r) => [r.deviceUserId, r.verifyType, r.state])).toEqual([['901', 1, 0]]);
      expect(await h.queue.getJob(processPunchesJobId(t.id))).toBeDefined();

      // The database, as the owner, inside the institute's context and without one. The device's
      // serial number is the control: found in the institute's context only.
      const inContext = (n: string[]) =>
        withTenant(owner, t.id, (tx) => findInDatabase(tx, n), { timeout: 20_000 });
      expect(await inContext([dev.serialNo])).toContain('attendance_devices.serial_no');
      expect(await findInDatabase(owner, [dev.serialNo])).toEqual([]);
      expect(await inContext(needles)).toEqual([]);
      expect(await findInDatabase(owner, needles)).toEqual([]);

      // Redis: every key, BullMQ's included. Controls: the refusal list and the job's data.
      expect(await findInRedis(h.redis, [unknown])).toContain('ingest:refused');
      expect((await findInRedis(h.redis, [t.id])).some((k) => k.includes('devices'))).toBe(true);
      expect(await findInRedis(h.redis, needles)).toEqual([]);

      // The logs.
      const logs = output.join('\n');
      expect(logs).toContain(`device refused: ${unknown} (UNKNOWN)`);
      for (const leak of ['console', 'console-error', 'buffer', 'nested-buffer', 'logger']) {
        expect(logs).toContain(`${planted}-${leak}`);
      }
      for (const needle of needles) expect(logs).not.toContain(needle);
    });
  });
});

describe('device receiver limits', () => {
  let h: IngestHarness;
  const { institute, addDevice, sim } = setup(
    () => h,
    () => new Date(),
  );

  beforeAll(async () => {
    h = await createIngestHarness({
      env: {
        INGEST_PER_IP_PER_MIN: '5',
        INGEST_PER_DEVICE_PER_MIN: '3',
        INGEST_PER_DEVICE_ALL_PER_MIN: '5',
        INGEST_REFUSED_PER_IP_PER_10MIN: '2',
        INGEST_MAX_DRAIN_BYTES: '65536',
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });
  afterEach(() => vi.restoreAllMocks());

  const ping = (sn: string, ip: string) =>
    ingestHttp(h).get(`/iclock/ping?SN=${sn}`).set('X-Forwarded-For', ip);
  const expectLimited = (res: {
    status: number;
    text: string;
    headers: Record<string, string>;
  }) => {
    expect([res.status, res.text]).toEqual([429, 'ERROR']);
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(600);
  };

  it('429 per address before anything else, without a database call', async () => {
    const query = vi.spyOn(h.ingestDb, '$queryRaw');
    const ip = randomIp();
    for (let i = 0; i < 5; i++) expect((await ping('bad', ip)).status).toBe(400);
    const res = await ping('bad', ip);
    expectLimited(res);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(query).not.toHaveBeenCalled();
  });

  it('429 per device and address: requests from elsewhere cannot use up the device’s share', async () => {
    const dev = await addDevice((await institute()).id);
    const query = vi.spyOn(h.ingestDb, '$queryRaw');
    // The device's first contact: its address is the trusted one.
    const own = randomIp();
    expect((await ping(dev.serialNo, own)).text).toBe('OK');
    const attacker = randomIp();
    for (let i = 0; i < 3; i++) expect((await ping(dev.serialNo, attacker)).text).toBe('OK');
    // Over its share: refused before any database call.
    expectLimited(await ping(dev.serialNo, attacker));
    expect(query).toHaveBeenCalledTimes(4);
    // The device itself, from its own address, still gets through.
    expect((await ping(dev.serialNo, own)).text).toBe('OK');
  });

  it('untrusted addresses share one budget per serial; the trusted address is never charged', async () => {
    const t = await institute();
    const dev = await addDevice(t.id);
    const own = randomIp();
    const device = sim(dev.serialNo, { forwardedFor: own });
    const poll = () =>
      ingestHttp(h).get(`/iclock/getrequest?SN=${dev.serialNo}`).set('X-Forwarded-For', own);
    // First contact: trusted. (Its own share is 3 a minute: this, an upload and a poll.)
    expect((await device.ping()).body).toBe('OK');
    // Rotating untrusted addresses, IPv4 and IPv6 /64s, one request each: 5 in all get through,
    // then every further one is refused, however many addresses take part.
    const stranger = (i: number) => (i % 2 ? randomIp() : `${prefix64()}::1`);
    for (let i = 0; i < 5; i++) expect((await ping(dev.serialNo, stranger(i))).text).toBe('OK');
    for (let i = 0; i < 4; i++) expectLimited(await ping(dev.serialNo, stranger(i)));
    // Meanwhile the trusted address keeps uploading and polling.
    expect((await device.punch('101')).body).toBe('OK: 1');
    expect((await poll()).text).toBe('OK');
    const [row] = await withTenant(h.prisma, t.id, (tx) =>
      tx.devicePunch.findMany({ where: { deviceId: dev.id } }),
    );
    // From the trusted address (this harness runs on the real clock, so other flags may vary).
    expect(row?.flags).not.toContain('NEW_IP');
    expect(row?.sourceIp).toBeNull();
  });

  /** A random IPv6 /64 prefix (documentation range), as `2001:db8:x:y`. */
  const prefix64 = () =>
    `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:${Math.floor(Math.random() * 0xffff).toString(16)}`;

  it('IPv6 addresses count per /64 for every limit; the full address reaches logs and the database', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const query = vi.spyOn(h.ingestDb, '$queryRaw');
    // Per address: five requests from five addresses of one /64, then the sixth is refused.
    const a = prefix64();
    for (let i = 1; i <= 5; i++) expect((await ping('bad', `${a}::${i}`)).status).toBe(400);
    expectLimited(await ping('bad', `${a}::99`));
    expect((await ping('bad', `${prefix64()}::1`)).status).toBe(400);

    // The refused brake: two unknown serials from two addresses of one /64 stop the third.
    const b = prefix64();
    const sn = newSerial();
    expect((await ping(sn, `${b}::a`)).status).toBe(403);
    expect((await ping(newSerial(), `${b}::b`)).status).toBe(403);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContain(
      `device refused: ${sn} (UNKNOWN) from ${b}::a`,
    );
    query.mockClear();
    expectLimited(await ping(newSerial(), `${b}::c`));
    expect(query).not.toHaveBeenCalled();

    // The per-device share: one /64 is one requester.
    const t = await institute();
    const dev = await addDevice(t.id);
    const c = prefix64();
    for (let i = 1; i <= 3; i++) expect((await ping(dev.serialNo, `${c}::${i}`)).text).toBe('OK');
    expectLimited(await ping(dev.serialNo, `${c}::4`));
    const row = await withTenant(h.prisma, t.id, (tx) =>
      tx.attendanceDevice.findUniqueOrThrow({ where: { id: dev.id } }),
    );
    expect(row.lastIp).toBe(`${c}::3`);
  });

  it('429 for an address after too many refused serials, without a database call', async () => {
    const dev = await addDevice((await institute()).id);
    const ip = randomIp();
    expect((await ping(newSerial(), ip)).status).toBe(403);
    expect((await ping(newSerial(), ip)).status).toBe(403);
    const query = vi.spyOn(h.ingestDb, '$queryRaw');
    expectLimited(await ping(newSerial(), ip));
    // Even a registered device, from that address.
    expectLimited(await ping(dev.serialNo, ip));
    expect(query).not.toHaveBeenCalled();
    expect((await ping(dev.serialNo, randomIp())).text).toBe('OK');
  });

  it('drops an upload beyond the drain limit by closing the connection', async () => {
    const dev = await addDevice((await institute()).id);
    const url = `${h.baseUrl}/iclock/cdata?SN=${dev.serialNo}&table=OPERLOG&Stamp=1`;
    const headers = { 'X-Forwarded-For': randomIp(), 'Content-Type': 'text/plain' };
    await expect(
      fetch(url, { method: 'POST', headers, body: 'x'.repeat(1024 * 1024) }),
    ).rejects.toThrow();
    const ok = await fetch(url, { method: 'POST', headers, body: 'x'.repeat(60_000) });
    expect([ok.status, await ok.text()]).toEqual([200, 'OK']);
  });
});

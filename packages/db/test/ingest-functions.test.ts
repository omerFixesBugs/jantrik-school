import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, ingestClient, ownerClient } from './helpers.js';

// The device receiver logs in as jantrik_ingest_app: no table grants, only the four ingest_*
// functions. They belong to jantrik_ingest (no tenant context, sees every institute), take a
// device's serial number and never a tenant or device id. See docs/database.md → Devices.

/** A serial number no earlier run has used: serials are unique across institutes. */
const newSerial = () => `T${randomUUID().replace(/-/g, '').slice(0, 15).toUpperCase()}`;

/** The receiver's clock (08:00 in Dhaka); the functions never read the database's own. */
const T0 = new Date('2026-10-20T02:00:00Z');
const MIN = 60_000;
const after = (ms: number) => new Date(T0.getTime() + ms);
const IP = '103.4.5.6';

interface PunchRow {
  device_user_id: string;
  device_time: string;
  punched_at: string;
  local_date: string;
  verify_type: number | null;
  state: number | null;
  direction: 'IN' | 'OUT';
  flags: string[];
}

/** A punch as the receiver passes it; `time` is the device's (Dhaka) wall clock. */
const punch = (pin: string, time: string, flags: string[] = []): PunchRow => ({
  device_user_id: pin,
  device_time: time,
  punched_at: `${time.replace(' ', 'T')}+06:00`,
  local_date: time.slice(0, 10),
  verify_type: 1,
  state: 0,
  direction: 'IN',
  flags,
});

/** `count` punches by different people in the minute starting at `minute` (HH:MM), 1 s apart. */
const burst = (minute: string, count: number, firstPin = 1000) =>
  Array.from({ length: count }, (_, i) =>
    punch(String(firstPin + i), `2026-10-20 ${minute}:${String(i % 60).padStart(2, '0')}`),
  );

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The Unix milliseconds in a UUIDv7's first 48 bits. */
const idMs = (id: string) => parseInt(id.replace(/-/g, '').slice(0, 12), 16);
/** A Timestamp(0) column as the device wrote it. */
const wallClock = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

const refused = (refusal: string) => ({
  accepted: false,
  refusal,
  device_id: null,
  tenant_id: null,
  time_zone: null,
  direction: null,
  attlog_stamp: null,
  clock_offset_sec: null,
  clock_samples: null,
  registered_on: null,
  hours_start: null,
  hours_end: null,
  max_per_minute: null,
  previous_seen_at: null,
  ip_trusted: null,
});

describe('ingest functions', () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  let ingest: PrismaClient;
  let a: string;
  let b: string;

  beforeAll(async () => {
    app = appClient();
    owner = ownerClient();
    ingest = ingestClient();
    a = (await createTenant(app, { status: 'ACTIVE', modules: ['ATTENDANCE'] })).id;
    b = (await createTenant(app, { status: 'TRIAL', modules: ['ATTENDANCE'] })).id;
  });

  afterAll(async () => {
    await Promise.all([app.$disconnect(), owner.$disconnect(), ingest.$disconnect()]);
  });

  const addDevice = (tenantId: string, isActive = true) =>
    withTenant(app, tenantId, (tx) =>
      tx.attendanceDevice.create({
        data: { tenantId, serialNo: newSerial(), name: 'Main gate', direction: 'BOTH', isActive },
      }),
    );
  const deviceRow = (tenantId: string, id: string) =>
    withTenant(app, tenantId, (tx) => tx.attendanceDevice.findUniqueOrThrow({ where: { id } }));
  const punchesOf = (tenantId: string, deviceId: string) =>
    withTenant(app, tenantId, (tx) =>
      tx.devicePunch.findMany({
        where: { deviceId },
        orderBy: [{ deviceTime: 'asc' }, { deviceUserId: 'asc' }],
      }),
    );
  const addressesOf = (tenantId: string, deviceId: string) =>
    withTenant(app, tenantId, (tx) =>
      tx.deviceSourceIp.findMany({ where: { deviceId }, orderBy: { firstSeenAt: 'asc' } }),
    );
  const queue = (tenantId: string, deviceId: string, pins: string[]) =>
    withTenant(app, tenantId, async (tx) => {
      const out = [];
      for (const pin of pins) {
        out.push(
          await tx.deviceCommand.create({
            data: {
              tenantId,
              deviceId,
              kind: 'USER_DELETE',
              deviceUserId: pin,
              payload: `DATA DELETE USERINFO PIN=${pin}`,
            },
          }),
        );
      }
      return out;
    });
  const commandsOf = (tenantId: string, deviceId: string) =>
    withTenant(app, tenantId, (tx) =>
      tx.deviceCommand.findMany({ where: { deviceId }, orderBy: { seq: 'asc' } }),
    );

  const resolve = async (
    sn: string | null,
    now = T0,
    info: {
      ip?: string | null;
      firmware?: string | null;
      userCount?: number | null;
      pushVersion?: string | null;
    } = {},
  ) => {
    const rows = await ingest.$queryRaw<Record<string, unknown>[]>`
      SELECT accepted, refusal, device_id, tenant_id, time_zone, direction::text AS direction,
             attlog_stamp, clock_offset_sec, clock_samples, registered_on::text AS registered_on,
             hours_start::text AS hours_start, hours_end::text AS hours_end, max_per_minute,
             previous_seen_at, ip_trusted
      FROM ingest_resolve(${sn}::text, ${info.ip === undefined ? IP : info.ip}::inet,
                          ${now}::timestamptz, ${info.firmware ?? null}::text,
                          ${info.userCount ?? null}::int, ${info.pushVersion ?? null}::text)`;
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };

  const store = (
    sn: string,
    rows: PunchRow[],
    opts: {
      ip?: string | null;
      now?: Date;
      stamp?: string | null;
      samples?: number[];
      offset?: number | null;
    } = {},
  ) =>
    ingest.$queryRaw<
      { tenant_id: string; inserted: number; duplicates: number; held: number; dropped: number }[]
    >`SELECT * FROM ingest_store_punches(${sn}::text,
        ${opts.ip === undefined ? IP : opts.ip}::inet, ${opts.now ?? T0}::timestamptz,
        ${JSON.stringify(rows)}::jsonb, ${opts.stamp ?? null}::text, ${opts.samples ?? []}::int[],
        ${opts.offset ?? null}::int)`;

  const take = (sn: string, now: Date, max: number | null = 10, ip: string | null = IP) =>
    ingest.$queryRaw<{ seq: bigint; payload: string }[]>`
      SELECT * FROM ingest_take_commands(${sn}::text, ${ip}::inet, ${now}::timestamptz,
                                         ${max}::int)`;

  const answer = async (
    sn: string,
    now: Date,
    results: { seq: bigint; code: number }[],
    ip: string | null = IP,
  ) => {
    const body = JSON.stringify(results.map((r) => ({ id: Number(r.seq), return_code: r.code })));
    const [row] = await ingest.$queryRaw<{ n: number }[]>`
      SELECT ingest_command_results(${sn}::text, ${ip}::inet, ${now}::timestamptz,
                                    ${body}::jsonb) AS n`;
    return row!.n;
  };

  /** An institute whose per-minute cap is 10. */
  const cappedInstitute = async () => {
    const t = await createTenant(app, { status: 'ACTIVE', modules: ['ATTENDANCE'] });
    await withTenant(app, t.id, (tx) =>
      tx.attendanceSettings.update({
        where: { tenantId: t.id },
        data: { deviceMaxPunchesPerMinute: 10 },
      }),
    );
    return t.id;
  };

  it('jantrik_ingest_app reads no table and cannot run the helpers', async () => {
    for (const table of ['attendance_devices', 'device_punches', 'students']) {
      await expect(ingest.$queryRawUnsafe(`SELECT * FROM ${table} LIMIT 1`)).rejects.toThrow(
        /permission denied/i,
      );
    }
    for (const sql of [
      'SELECT ingest_uuid7(now())',
      "SELECT * FROM ingest_find_device('ABC123')",
      "SELECT * FROM ingest_find_device_at('ABC123', '10.0.0.1', now())",
    ]) {
      await expect(ingest.$queryRawUnsafe(sql)).rejects.toThrow(/permission denied/i);
    }
  });

  it('jantrik_app cannot run the ingest functions', async () => {
    for (const sql of [
      "SELECT * FROM ingest_resolve('ABC123', NULL, now(), NULL, NULL, NULL)",
      "SELECT * FROM ingest_store_punches('ABC123', NULL, now(), '[]', NULL, '{}', NULL)",
      "SELECT * FROM ingest_take_commands('ABC123', NULL, now(), 10)",
      "SELECT ingest_command_results('ABC123', NULL, now(), '[]')",
    ]) {
      await expect(app.$queryRawUnsafe(sql)).rejects.toThrow(/permission denied/i);
    }
  });

  it('refuses unknown, malformed, inactive, suspended and module-off serials', async () => {
    for (const sn of [
      newSerial(),
      'AB-12345',
      'AB12',
      `A${'1'.repeat(32)}`,
      '',
      'ÄBC12345',
      null,
    ]) {
      expect(await resolve(sn)).toEqual(refused('UNKNOWN'));
    }
    const inactive = await addDevice(a, false);
    expect(await resolve(inactive.serialNo)).toEqual(refused('INACTIVE'));

    for (const status of ['SUSPENDED', 'ARCHIVED'] as const) {
      const t = await createTenant(app, { status, modules: ['ATTENDANCE'] });
      expect(await resolve((await addDevice(t.id)).serialNo)).toEqual(
        refused('INSTITUTE_INACTIVE'),
      );
    }

    // ATTENDANCE switched off, and (an institute from before every module had a row) missing.
    const off = await createTenant(app, { status: 'ACTIVE', modules: [] });
    expect(await resolve((await addDevice(off.id)).serialNo)).toEqual(refused('MODULE_OFF'));
    const type = await app.instituteType.findFirstOrThrow({ where: { key: 'NCTB_SCHOOL_BN' } });
    const id = randomUUID();
    const missing = await withTenant(app, id, async (tx) => {
      await tx.tenant.create({
        data: { id, slug: `m-${id.slice(0, 8)}`, name: 'Old', instituteTypeId: type.id },
      });
      await tx.tenantModule.create({ data: { tenantId: id, moduleKey: 'CORE' } });
      return tx.attendanceDevice.create({
        data: { tenantId: id, serialNo: newSerial(), name: 'Gate', direction: 'IN' },
      });
    });
    expect(await resolve(missing.serialNo)).toEqual(refused('MODULE_OFF'));
  });

  it('a refused serial gets nothing from any function and writes nothing', async () => {
    const t = await createTenant(app, { status: 'SUSPENDED', modules: ['ATTENDANCE'] });
    const suspended = await addDevice(t.id);
    const inactive = await addDevice(a, false);
    for (const [tenantId, dev] of [
      [t.id, suspended],
      [a, inactive],
    ] as const) {
      const [command] = await queue(tenantId, dev.id, ['101']);
      await resolve(dev.serialNo, T0, { firmware: 'Ver 6.60', userCount: 3 });
      expect(await store(dev.serialNo, [punch('101', '2026-10-20 08:00:00')])).toEqual([]);
      expect(await take(dev.serialNo, T0)).toEqual([]);
      expect(await answer(dev.serialNo, T0, [{ seq: command!.seq, code: 0 }])).toBe(0);

      expect(await deviceRow(tenantId, dev.id)).toMatchObject({
        lastSeenAt: null,
        lastIp: null,
        firmware: null,
        userCount: null,
        lastPunchAt: null,
        clockSamples: [],
      });
      expect(await punchesOf(tenantId, dev.id)).toEqual([]);
      expect(await addressesOf(tenantId, dev.id)).toEqual([]);
      expect((await commandsOf(tenantId, dev.id)).map((c) => [c.status, c.attempts])).toEqual([
        ['PENDING', 0],
      ]);
    }
  });

  it("resolve returns the device and its institute's settings and records the visit", async () => {
    const dev = await addDevice(a);
    const first = await resolve(dev.serialNo.toLowerCase(), T0, {
      firmware: 'Ver 6.60',
      userCount: 12,
      pushVersion: '2.4.1',
    });
    expect(first).toEqual({
      accepted: true,
      refusal: null,
      device_id: dev.id,
      tenant_id: a,
      time_zone: 'Asia/Dhaka',
      direction: 'BOTH',
      attlog_stamp: null,
      clock_offset_sec: null,
      clock_samples: [],
      registered_on: new Date(dev.createdAt.getTime() + 6 * 3600_000).toISOString().slice(0, 10),
      hours_start: '05:00:00',
      hours_end: '20:00:00',
      max_per_minute: 60,
      previous_seen_at: null,
      ip_trusted: true,
    });
    expect(await deviceRow(a, dev.id)).toMatchObject({
      lastSeenAt: T0,
      lastIp: IP,
      firmware: 'Ver 6.60',
      userCount: 12,
      pushVersion: '2.4.1',
    });

    // Missing device info keeps what was stored; the address is the latest one.
    const second = await resolve(dev.serialNo, after(MIN), { ip: '198.51.100.7' });
    expect(second).toMatchObject({ accepted: true, previous_seen_at: T0, ip_trusted: false });
    expect(await deviceRow(a, dev.id)).toMatchObject({
      lastSeenAt: after(MIN),
      lastIp: '198.51.100.7',
      firmware: 'Ver 6.60',
      userCount: 12,
      pushVersion: '2.4.1',
    });
  });

  it("returns the institute's device hours and cap, or the defaults without a settings row", async () => {
    const t = await createTenant(app, { status: 'ACTIVE', modules: ['ATTENDANCE'] });
    await withTenant(app, t.id, (tx) =>
      tx.attendanceSettings.update({
        where: { tenantId: t.id },
        data: {
          deviceHoursStart: new Date('1970-01-01T06:30:00Z'),
          deviceHoursEnd: new Date('1970-01-01T18:00:00Z'),
          deviceMaxPunchesPerMinute: 30,
        },
      }),
    );
    expect(await resolve((await addDevice(t.id)).serialNo)).toMatchObject({
      hours_start: '06:30:00',
      hours_end: '18:00:00',
      max_per_minute: 30,
    });

    const type = await app.instituteType.findFirstOrThrow({ where: { key: 'NCTB_SCHOOL_BN' } });
    const id = randomUUID();
    const dev = await withTenant(app, id, async (tx) => {
      await tx.tenant.create({
        data: { id, slug: `s-${id.slice(0, 8)}`, name: 'No settings', instituteTypeId: type.id },
      });
      await tx.tenantModule.createMany({
        data: [
          { tenantId: id, moduleKey: 'CORE' },
          { tenantId: id, moduleKey: 'ATTENDANCE' },
        ],
      });
      return tx.attendanceDevice.create({
        data: { tenantId: id, serialNo: newSerial(), name: 'Gate', direction: 'IN' },
      });
    });
    expect(await resolve(dev.serialNo)).toMatchObject({
      accepted: true,
      direction: 'IN',
      hours_start: '05:00:00',
      hours_end: '20:00:00',
      max_per_minute: 60,
    });
    expect(await store(dev.serialNo, [punch('101', '2026-10-20 08:00:00')])).toEqual([
      { tenant_id: id, inserted: 1, duplicates: 0, held: 0, dropped: 0 },
    ]);
  });

  it('stores a batch once: a repeated batch, or a repeat inside one, counts as duplicates', async () => {
    const dev = await addDevice(a);
    const batch = [
      punch('101', '2026-10-20 08:00:05', ['OUTSIDE_HOURS']),
      punch('102', '2026-10-20 08:00:09'),
      { ...punch('101', '2026-10-20 13:30:00'), direction: 'OUT' as const, state: 1 },
    ];
    expect(await store(dev.serialNo, batch)).toEqual([
      { tenant_id: a, inserted: 3, duplicates: 0, held: 0, dropped: 0 },
    ]);
    expect(await store(dev.serialNo, batch, { now: after(MIN) })).toEqual([
      { tenant_id: a, inserted: 0, duplicates: 3, held: 0, dropped: 0 },
    ]);
    const same = punch('103', '2026-10-20 08:01:00');
    expect(await store(dev.serialNo, [same, same], { now: after(MIN) })).toEqual([
      { tenant_id: a, inserted: 1, duplicates: 1, held: 0, dropped: 0 },
    ]);

    const rows = await punchesOf(a, dev.id);
    expect(
      rows.map((p) => ({
        tenantId: p.tenantId,
        pin: p.deviceUserId,
        deviceTime: wallClock(p.deviceTime),
        punchedAt: p.punchedAt.toISOString(),
        localDate: p.localDate.toISOString().slice(0, 10),
        receivedAt: p.receivedAt.toISOString(),
        verifyType: p.verifyType,
        state: p.state,
        direction: p.direction,
        flags: p.flags,
        sourceIp: p.sourceIp,
        processedAt: p.processedAt,
      })),
    ).toEqual([
      {
        tenantId: a,
        pin: '101',
        deviceTime: '2026-10-20 08:00:05',
        punchedAt: '2026-10-20T02:00:05.000Z',
        localDate: '2026-10-20',
        receivedAt: T0.toISOString(),
        verifyType: 1,
        state: 0,
        direction: 'IN',
        flags: ['OUTSIDE_HOURS'],
        sourceIp: null,
        processedAt: null,
      },
      expect.objectContaining({ pin: '102', flags: [] }),
      expect.objectContaining({ pin: '103', receivedAt: after(MIN).toISOString() }),
      expect.objectContaining({ pin: '101', direction: 'OUT', state: 1 }),
    ]);
  });

  it("gives punches and addresses time-ordered UUIDv7 ids from the receiver's clock", async () => {
    const dev = await addDevice(a);
    const first = after(250);
    const second = after(1250);
    await store(dev.serialNo, burst('09:00', 20), { now: first });
    await store(dev.serialNo, burst('09:01', 20), { now: second, ip: '198.51.100.7' });
    const rows = await punchesOf(a, dev.id);
    const ids = rows.map((p) => p.id);
    expect(new Set(ids).size).toBe(40);
    for (const p of rows) {
      expect(p.id).toMatch(UUID_V7);
      expect(idMs(p.id)).toBe(p.receivedAt.getTime());
    }
    const firstIds = rows
      .filter((p) => p.receivedAt.getTime() === first.getTime())
      .map((p) => p.id);
    const secondIds = rows
      .filter((p) => p.receivedAt.getTime() === second.getTime())
      .map((p) => p.id);
    expect(firstIds).toHaveLength(20);
    expect([...firstIds].sort().at(-1)! < [...secondIds].sort()[0]!).toBe(true);
    const addresses = await addressesOf(a, dev.id);
    expect(addresses.map((x) => [idMs(x.id), UUID_V7.test(x.id)])).toEqual([
      [first.getTime(), true],
      [second.getTime(), true],
    ]);
  });

  it('trusts the first address; punches from an untrusted one get NEW_IP and the address', async () => {
    const dev = await addDevice(a);
    const other = '198.51.100.7';
    await store(dev.serialNo, [
      punch('101', '2026-10-20 08:00:00'),
      punch('102', '2026-10-20 08:00:01'),
    ]);
    await store(dev.serialNo, [punch('103', '2026-10-20 08:01:00', ['OUTSIDE_HOURS'])], {
      ip: other,
      now: after(MIN),
    });
    await store(dev.serialNo, [punch('104', '2026-10-20 08:02:00')], {
      ip: other,
      now: after(2 * MIN),
    });
    await store(dev.serialNo, [punch('105', '2026-10-20 08:03:00')], { now: after(3 * MIN) });
    // No address (the receiver could not tell): nothing recorded, nothing flagged.
    await store(dev.serialNo, [punch('106', '2026-10-20 08:04:00')], {
      ip: null,
      now: after(4 * MIN),
    });

    expect((await punchesOf(a, dev.id)).map((p) => [p.deviceUserId, p.flags, p.sourceIp])).toEqual([
      ['101', [], null],
      ['102', [], null],
      ['103', ['OUTSIDE_HOURS', 'NEW_IP'], other],
      ['104', ['NEW_IP'], other],
      ['105', [], null],
      ['106', [], null],
    ]);
    expect(
      (await addressesOf(a, dev.id)).map((x) => ({
        ip: x.ip,
        firstSeenAt: x.firstSeenAt,
        lastSeenAt: x.lastSeenAt,
        punchCount: x.punchCount,
        trustedAt: x.trustedAt,
        trustedById: x.trustedById,
      })),
    ).toEqual([
      {
        ip: IP,
        firstSeenAt: T0,
        lastSeenAt: after(3 * MIN),
        punchCount: 3,
        trustedAt: T0,
        trustedById: null,
      },
      {
        ip: other,
        firstSeenAt: after(MIN),
        lastSeenAt: after(2 * MIN),
        punchCount: 2,
        trustedAt: null,
        trustedById: null,
      },
    ]);

    // Once an admin trusts it, its punches are no longer flagged.
    await withTenant(app, a, (tx) =>
      tx.deviceSourceIp.updateMany({
        where: { deviceId: dev.id, ip: other },
        data: { trustedAt: after(5 * MIN) },
      }),
    );
    await store(dev.serialNo, [punch('107', '2026-10-20 08:05:00')], {
      ip: other,
      now: after(6 * MIN),
    });
    expect((await punchesOf(a, dev.id)).at(-1)).toMatchObject({
      deviceUserId: '107',
      flags: [],
      sourceIp: null,
    });
  });

  it('keeps 50 untrusted addresses per device: a new one evicts the least recently seen', async () => {
    const dev = await addDevice(a);
    await resolve(dev.serialNo); // IP: trusted on first contact
    const ipN = (n: number) => `10.0.0.${n}`;
    const trust = (ip: string) =>
      withTenant(app, a, (tx) =>
        tx.deviceSourceIp.updateMany({
          where: { deviceId: dev.id, ip },
          data: { trustedAt: after(MIN) },
        }),
      );
    // Addresses one after another (an attacker rotating them); the admin trusted the first.
    for (let n = 1; n <= 51; n++) {
      expect(await resolve(dev.serialNo, after(n * MIN), { ip: ipN(n) })).toMatchObject({
        ip_trusted: false,
      });
      if (n === 1) await trust(ipN(1));
    }
    const trusted = async () => (await addressesOf(a, dev.id)).filter((x) => x.trustedAt !== null);
    const trustedBefore = await trusted();
    expect(trustedBefore.map((x) => x.ip)).toEqual([IP, ipN(1)]);
    // 2…51 fill the 50 untrusted places. 2 is seen again, so 3 is now the least recently seen:
    // the 52nd address evicts 3, an upload from the 53rd evicts 4 (and its punch is flagged).
    await resolve(dev.serialNo, after(60 * MIN), { ip: ipN(2) });
    await resolve(dev.serialNo, after(61 * MIN), { ip: ipN(52) });
    await store(dev.serialNo, [punch('101', '2026-10-20 08:00:00')], {
      ip: ipN(53),
      now: after(62 * MIN),
    });
    expect((await punchesOf(a, dev.id)).map((p) => [p.flags, p.sourceIp])).toEqual([
      [['NEW_IP'], ipN(53)],
    ]);
    const untrusted = (await addressesOf(a, dev.id)).filter((x) => x.trustedAt === null);
    expect(untrusted.map((x) => x.ip).sort()).toEqual(
      [2, ...Array.from({ length: 49 }, (_, i) => i + 5)].map(ipN).sort(),
    );
    expect(untrusted.find((x) => x.ip === ipN(53))).toMatchObject({ punchCount: 1 });
    // Trusted rows are never evicted, nor changed by it.
    expect(await trusted()).toEqual(trustedBefore);
  });

  it('trusts a first address automatically only on first contact within 24 hours of registration', async () => {
    const hours = (dev: { createdAt: Date }, h: number) =>
      new Date(dev.createdAt.getTime() + h * 3600_000);

    // A fresh institute whose first device has been seen: the decision is about the calling
    // device, never another one of its institute.
    const t = (await createTenant(app, { status: 'ACTIVE', modules: ['ATTENDANCE'] })).id;

    // Seen before (here without an address): not a first contact any more.
    const seen = await addDevice(t);
    await resolve(seen.serialNo, hours(seen, 1), { ip: null });
    expect(await resolve(seen.serialNo, hours(seen, 2))).toMatchObject({ ip_trusted: false });

    const early = await addDevice(t);
    expect(await resolve(early.serialNo, hours(early, 23.5))).toMatchObject({ ip_trusted: true });

    // Later: recorded untrusted, so its punches are flagged and it gets no commands until an
    // admin trusts the address.
    const late = await addDevice(t);
    const [command] = await queue(t, late.id, ['101']);
    expect(await resolve(late.serialNo, hours(late, 24.5))).toMatchObject({
      accepted: true,
      ip_trusted: false,
    });
    await store(late.serialNo, [punch('101', '2026-10-20 08:00:00')], { now: hours(late, 24.6) });
    expect((await punchesOf(t, late.id)).map((p) => p.flags)).toEqual([['NEW_IP']]);
    expect(await take(late.serialNo, hours(late, 24.7))).toEqual([]);
    expect((await addressesOf(t, late.id)).map((x) => [x.ip, x.trustedAt])).toEqual([[IP, null]]);
    await withTenant(app, t, (tx) =>
      tx.deviceSourceIp.updateMany({
        where: { deviceId: late.id, ip: IP },
        data: { trustedAt: hours(late, 25) },
      }),
    );
    expect((await take(late.serialNo, hours(late, 26))).map((c) => c.seq)).toEqual([command!.seq]);

    // An upload follows the same rule.
    const uploaded = await addDevice(t);
    await store(uploaded.serialNo, [punch('101', '2026-10-20 08:00:00')], {
      now: hours(uploaded, 25),
    });
    expect((await punchesOf(t, uploaded.id)).map((p) => [p.flags, p.sourceIp])).toEqual([
      [['NEW_IP'], IP],
    ]);
  });

  it("checks an address against the calling device's own trusted addresses", async () => {
    const x1 = await addDevice(a);
    const x2 = await addDevice(a);
    const y1 = await addDevice(b);
    const [ipX1, ipX2, ipY1] = ['192.0.2.11', '192.0.2.12', '192.0.2.13'];
    // Each device trusts its own first address.
    await resolve(x1.serialNo, T0, { ip: ipX1 });
    await resolve(x2.serialNo, T0, { ip: ipX2 });
    await resolve(y1.serialNo, T0, { ip: ipY1 });
    // X1 has a command sent 5 times and unanswered since T0: X1's next call fails it.
    const [exhausted] = await queue(a, x1.id, ['101']);
    await withTenant(owner, a, (tx) =>
      tx.deviceCommand.update({
        where: { id: exhausted!.id },
        data: { status: 'SENT', attempts: 5, sentAt: T0 },
      }),
    );
    const [own] = await queue(a, x2.id, ['102']);
    const status = async (tenantId: string, deviceId: string) =>
      (await commandsOf(tenantId, deviceId)).map((c) => [c.status, c.attempts]);

    // X2 from an address only X1 trusts (same institute), or only Y1 trusts (another): nothing.
    for (const ip of [ipX1, ipY1]) {
      expect(await take(x2.serialNo, after(10 * MIN), 10, ip)).toEqual([]);
      expect(await answer(x2.serialNo, after(10 * MIN), [{ seq: own!.seq, code: 0 }], ip)).toBe(0);
    }
    expect(await status(a, x2.id)).toEqual([['PENDING', 0]]);

    // From its own address, its own command; X1's exhausted one is not X2's to fail.
    expect((await take(x2.serialNo, after(10 * MIN), 10, ipX2)).map((c) => c.seq)).toEqual([
      own!.seq,
    ]);
    expect(await status(a, x1.id)).toEqual([['SENT', 5]]);
    expect(await take(x1.serialNo, after(10 * MIN), 10, ipX1)).toEqual([]);
    expect(await status(a, x1.id)).toEqual([['FAILED', 5]]);
  });

  it.each(['resolve', 'store'] as const)(
    '%s refuses a device deactivated, and its serial number registered again, while the call waits',
    async (kind) => {
      const old = await addDevice(a);
      let registered!: (xid: string) => void;
      let commit!: () => void;
      const ready = new Promise<string>((r) => (registered = r));
      const go = new Promise<void>((r) => (commit = r));
      // An admin deactivates the device and registers its serial number again, as a new device.
      const admin = withTenant(
        app,
        a,
        async (tx) => {
          await tx.attendanceDevice.update({ where: { id: old.id }, data: { isActive: false } });
          const replacement = await tx.attendanceDevice.create({
            data: { tenantId: a, serialNo: old.serialNo, name: 'New gate', direction: 'IN' },
          });
          // The admin's transaction id: the call below waits for exactly this one.
          const [{ xid }] = await tx.$queryRaw<{ xid: string }[]>`
            SELECT pg_current_xact_id()::xid::text AS xid`;
          registered(xid);
          await go;
          return replacement;
        },
        { timeout: 20_000 },
      );
      const adminXid = await ready;
      // Started now (a Prisma query runs only once awaited).
      const call = (async () =>
        kind === 'resolve'
          ? resolve(old.serialNo)
          : store(old.serialNo, [punch('101', '2026-10-20 08:00:00')]))();
      // Wait until the call waits for the device's lock (the admin's transaction), then commit.
      // Only a receiver session waiting on that transaction counts, never another test's.
      try {
        for (let i = 0; ; i++) {
          const [w] = await app.$queryRaw<{ n: bigint }[]>`
            SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
            WHERE NOT l.granted AND s.usename = 'jantrik_ingest_app'
              AND l.locktype = 'transactionid' AND l.transactionid = ${adminXid}::xid`;
          if (w!.n > 0n) break;
          if (i > 100) throw new Error('the call never waited for the lock');
          await new Promise((r) => setTimeout(r, 50));
        }
      } finally {
        commit();
      }
      const replacement = await admin;

      expect(await call).toEqual(kind === 'resolve' ? refused('INACTIVE') : []);
      // Nothing written under either device.
      for (const id of [old.id, replacement.id]) {
        expect(await deviceRow(a, id)).toMatchObject({ lastSeenAt: null, lastIp: null });
        expect(await addressesOf(a, id)).toEqual([]);
        expect(await punchesOf(a, id)).toEqual([]);
      }
      // The next call reaches the new device.
      expect(await resolve(old.serialNo)).toMatchObject({ device_id: replacement.id });
    },
  );

  it('caps punches per device and minute: over N held as BURST, from 5 x N dropped', async () => {
    const t = { id: await cappedInstitute() };
    const dev = await addDevice(t.id);
    // 51 punches in 08:00, then one in 08:01 (a new minute starts again from zero).
    const rows = [...burst('08:00', 51), punch('2000', '2026-10-20 08:01:00')];
    expect(await store(dev.serialNo, rows)).toEqual([
      { tenant_id: t.id, inserted: 51, duplicates: 0, held: 40, dropped: 1 },
    ]);
    const stored = await punchesOf(t.id, dev.id);
    const flagsOf = (pin: number) => stored.find((p) => p.deviceUserId === String(pin))?.flags;
    expect(flagsOf(1009)).toEqual([]); // the 10th
    expect(flagsOf(1010)).toEqual(['BURST']); // the 11th
    expect(flagsOf(1049)).toEqual(['BURST']); // the 50th
    expect(flagsOf(1050)).toBeUndefined(); // the 51st: dropped
    expect(flagsOf(2000)).toEqual([]);
    expect(stored.filter((p) => p.flags.includes('BURST'))).toHaveLength(40);
    expect(await deviceRow(t.id, dev.id)).toMatchObject({
      lastFloodAt: T0,
      lastFloodDropped: 1,
    });

    // The minute is full across uploads too; a punch already stored is a duplicate, not dropped.
    expect(
      await store(dev.serialNo, [burst('08:00', 1)[0]!, punch('3000', '2026-10-20 08:00:59')], {
        now: after(MIN),
      }),
    ).toEqual([{ tenant_id: t.id, inserted: 0, duplicates: 1, held: 0, dropped: 1 }]);
    // An upload that drops nothing leaves the last flood as it was.
    await store(dev.serialNo, [punch('3001', '2026-10-20 08:05:00')], { now: after(2 * MIN) });
    expect(await deviceRow(t.id, dev.id)).toMatchObject({
      lastFloodAt: after(MIN),
      lastFloodDropped: 1,
    });
  });

  it('applies the cap in the order of the upload, whatever the order of the times', async () => {
    const t = await cappedInstitute();
    const dev = await addDevice(t);
    // 08:00 already has 8. Then, out of time order and interleaved with 08:01: four new rows in
    // 08:00 (c = 8, 9, 10, 11 in the upload's order, so the last two are held, not the latest
    // two), a copy of one of them and a punch stored before (both duplicates).
    await store(dev.serialNo, burst('08:00', 8));
    const rows = [
      punch('2003', '2026-10-20 08:00:50'),
      punch('3001', '2026-10-20 08:01:00'),
      punch('2004', '2026-10-20 08:00:45'),
      punch('2001', '2026-10-20 08:00:40'),
      punch('2003', '2026-10-20 08:00:50'),
      punch('2002', '2026-10-20 08:00:30'),
      punch('1000', '2026-10-20 08:00:00'),
    ];
    expect(await store(dev.serialNo, rows, { now: after(MIN) })).toEqual([
      { tenant_id: t, inserted: 5, duplicates: 2, held: 2, dropped: 0 },
    ]);
    const flags = new Map(
      (await punchesOf(t, dev.id)).map((p) => [p.deviceUserId, p.flags] as const),
    );
    expect(['2003', '2004', '2001', '2002', '3001'].map((pin) => flags.get(pin))).toEqual([
      [],
      [],
      ['BURST'],
      ['BURST'],
      [],
    ]);

    // A full minute drops a row and a later copy of it alike; nothing of a dropped row is stored.
    await store(dev.serialNo, burst('08:02', 50, 4000), { now: after(2 * MIN) });
    expect(
      await store(
        dev.serialNo,
        [punch('5000', '2026-10-20 08:02:59'), punch('5000', '2026-10-20 08:02:59')],
        { now: after(3 * MIN) },
      ),
    ).toEqual([{ tenant_id: t, inserted: 0, duplicates: 0, held: 0, dropped: 2 }]);
  });

  it('records the stamp, the clock and the last punch on the device', async () => {
    const dev = await addDevice(a);
    await store(dev.serialNo, [punch('101', '2026-10-20 08:10:00')], {
      stamp: '9999123',
      samples: [61, 62, 60],
      offset: 61,
    });
    expect(await deviceRow(a, dev.id)).toMatchObject({
      attlogStamp: '9999123',
      clockSamples: [61, 62, 60],
      clockOffsetSec: 61,
      lastPunchAt: new Date('2026-10-20T02:10:00Z'),
    });
    // A stamp of 0, a malformed one or none keeps the last; an older punch keeps the last punch.
    for (const stamp of ['0', 'abc def', null]) {
      await store(dev.serialNo, [punch('102', '2026-10-20 07:50:00')], { stamp, samples: [61] });
    }
    expect(await deviceRow(a, dev.id)).toMatchObject({
      attlogStamp: '9999123',
      clockSamples: [61],
      clockOffsetSec: null,
      lastPunchAt: new Date('2026-10-20T02:10:00Z'),
    });
  });

  it("refuses more than 10000 rows, or rows that aren't an array of objects", async () => {
    const dev = await addDevice(a);
    const many = Array.from({ length: 10_001 }, () => punch('101', '2026-10-20 08:00:00'));
    await expect(store(dev.serialNo, many)).rejects.toThrow(/INGEST_TOO_MANY_ROWS/);
    await expect(
      ingest.$queryRaw`SELECT * FROM ingest_store_punches(${dev.serialNo}::text, NULL, now(),
        '{"device_user_id": "101"}'::jsonb, NULL, '{}', NULL)`,
    ).rejects.toThrow(/INGEST_BAD_ROWS/);
    await expect(
      ingest.$queryRaw`SELECT * FROM ingest_store_punches(${dev.serialNo}::text, NULL, now(),
        '[5]'::jsonb, NULL, '{}', NULL)`,
    ).rejects.toThrow(/on a scalar/);
    expect(await punchesOf(a, dev.id)).toEqual([]);
  });

  // Every function scopes by the device it resolved: (tenant_id, device id). The policies it runs
  // under see every institute, so these would catch a lost scope, whole or only the device's.
  it('a device touches only its own rows: not another device of its institute, nor another institute', async () => {
    const x = await cappedInstitute();
    const y = await cappedInstitute();
    const x1 = await addDevice(x);
    const x2 = await addDevice(x);
    const y1 = await addDevice(y);

    // X1: seen, with a stamp, a clock, a flood, a sent and a pending command.
    await resolve(x1.serialNo, T0, { firmware: 'X1', userCount: 1, pushVersion: '1.0' });
    expect(
      await store(x1.serialNo, burst('08:00', 51), { stamp: '111', samples: [1], offset: 1 }),
    ).toEqual([{ tenant_id: x, inserted: 50, duplicates: 0, held: 40, dropped: 1 }]);
    const x1Commands = await queue(x, x1.id, ['101', '103']);
    expect((await take(x1.serialNo, T0, 1)).map((c) => c.seq)).toEqual([x1Commands[0]!.seq]);
    const x1State = async () => ({
      device: await deviceRow(x, x1.id),
      punches: await punchesOf(x, x1.id),
      addresses: await addressesOf(x, x1.id),
      commands: await commandsOf(x, x1.id),
    });
    const before = await x1State();
    expect(before.device).toMatchObject({ attlogStamp: '111', lastFloodDropped: 1 });

    // X2 (the same institute) and Y1 (another) do all of it again, later, with other values and
    // from X1's address (devices of one school share its public address).
    for (const [tenantId, dev] of [
      [x, x2],
      [y, y1],
    ] as const) {
      const [own] = await queue(tenantId, dev.id, ['102']);
      expect(
        await resolve(dev.serialNo, after(MIN), {
          ip: IP,
          firmware: 'other',
          userCount: 2,
          pushVersion: '2.0',
        }),
      ).toMatchObject({ tenant_id: tenantId, device_id: dev.id, ip_trusted: true });
      // X1's very punches, in X1's full minute: this device's own, none a duplicate.
      expect(
        await store(dev.serialNo, burst('08:00', 51), {
          ip: IP,
          now: after(MIN),
          stamp: '222',
          samples: [2, 2],
          offset: 2,
        }),
      ).toEqual([{ tenant_id: tenantId, inserted: 50, duplicates: 0, held: 40, dropped: 1 }]);
      // Neither X1's sent command nor its pending one.
      expect((await take(dev.serialNo, after(MIN), 10, IP)).map((c) => c.seq)).toEqual([own!.seq]);
      expect(
        await answer(
          dev.serialNo,
          after(MIN),
          x1Commands.map((c) => ({ seq: c.seq, code: 0 })),
          IP,
        ),
      ).toBe(0);
      expect(await answer(dev.serialNo, after(MIN), [{ seq: own!.seq, code: 0 }], IP)).toBe(1);
      expect(await deviceRow(tenantId, dev.id)).toMatchObject({
        lastSeenAt: after(MIN),
        firmware: 'other',
        attlogStamp: '222',
        clockSamples: [2, 2],
        lastFloodAt: after(MIN),
      });
      // Its own first address: trusted, with its own punches.
      expect(
        (await addressesOf(tenantId, dev.id)).map((r) => [r.ip, r.trustedAt, r.punchCount]),
      ).toEqual([[IP, after(MIN), 50]]);
    }

    expect(await x1State()).toEqual(before);
    expect(await withTenant(app, y, (tx) => tx.devicePunch.count())).toBe(50);
  });

  it('hands commands only to an address the device trusts, and takes answers only from one', async () => {
    const dev = await addDevice(a);
    const other = '198.51.100.7';
    const [first, second] = await queue(a, dev.id, ['101', '102']);
    const commands = async () =>
      (await commandsOf(a, dev.id)).map((c) => [c.status, c.attempts, c.returnCode]);

    // First contact trusts its address; no address records nothing; a later one is recorded,
    // untrusted.
    expect(await resolve(dev.serialNo, T0)).toMatchObject({ ip_trusted: true });
    expect(await resolve(dev.serialNo, T0, { ip: null })).toMatchObject({
      accepted: true,
      ip_trusted: false,
    });
    expect(await resolve(dev.serialNo, after(MIN), { ip: other })).toMatchObject({
      ip_trusted: false,
    });
    expect(await resolve(dev.serialNo, after(2 * MIN), { ip: other })).toMatchObject({
      ip_trusted: false,
    });
    const addresses = async () =>
      (await addressesOf(a, dev.id)).map((x) => [
        x.ip,
        x.trustedAt,
        x.firstSeenAt,
        x.lastSeenAt,
        x.punchCount,
      ]);
    expect(await addresses()).toEqual([
      [IP, T0, T0, T0, 0],
      [other, null, after(MIN), after(2 * MIN), 0],
    ]);

    // From the untrusted address, no address, or one never seen: nothing taken or answered.
    for (const ip of [other, null, '192.0.2.1']) {
      expect(await take(dev.serialNo, after(2 * MIN), 10, ip)).toEqual([]);
      expect(await answer(dev.serialNo, after(2 * MIN), [{ seq: first!.seq, code: 0 }], ip)).toBe(
        0,
      );
    }
    expect(await commands()).toEqual([
      ['PENDING', 0, null],
      ['PENDING', 0, null],
    ]);
    expect(await addresses()).toHaveLength(2);

    // The trusted address takes them; the untrusted one still cannot answer.
    expect((await take(dev.serialNo, after(2 * MIN), 1)).map((c) => c.seq)).toEqual([first!.seq]);
    expect(await answer(dev.serialNo, after(3 * MIN), [{ seq: first!.seq, code: 0 }], other)).toBe(
      0,
    );
    expect(await commands()).toEqual([
      ['SENT', 1, null],
      ['PENDING', 0, null],
    ]);

    // Punches from the address resolve recorded: the same row, counting punches only.
    await store(dev.serialNo, [punch('101', '2026-10-20 08:10:00')], {
      ip: other,
      now: after(3 * MIN),
    });
    expect((await punchesOf(a, dev.id)).map((p) => [p.flags, p.sourceIp])).toEqual([
      [['NEW_IP'], other],
    ]);
    expect(await addresses()).toEqual([
      [IP, T0, T0, T0, 0],
      [other, null, after(MIN), after(3 * MIN), 1],
    ]);

    // Once an admin trusts it (as the API does, as the app role), it works from there too.
    await withTenant(app, a, (tx) =>
      tx.deviceSourceIp.updateMany({
        where: { deviceId: dev.id, ip: other },
        data: { trustedAt: after(4 * MIN) },
      }),
    );
    expect(await resolve(dev.serialNo, after(5 * MIN), { ip: other })).toMatchObject({
      ip_trusted: true,
    });
    expect((await take(dev.serialNo, after(5 * MIN), 10, other)).map((c) => c.seq)).toEqual([
      second!.seq,
    ]);
    expect(
      await answer(
        dev.serialNo,
        after(5 * MIN),
        [
          { seq: first!.seq, code: 0 },
          { seq: second!.seq, code: 0 },
        ],
        other,
      ),
    ).toBe(2);
    expect(await commands()).toEqual([
      ['DONE', 1, 0],
      ['DONE', 1, 0],
    ]);
  });

  it('delivers commands in order, again after 5 minutes, and fails them after 5 attempts', async () => {
    const dev = await addDevice(a);
    await resolve(dev.serialNo);
    const queued = await queue(a, dev.id, ['101', '102', '103', '104']);
    await withTenant(app, a, (tx) =>
      tx.deviceCommand.update({ where: { id: queued[3]!.id }, data: { status: 'CANCELLED' } }),
    );
    const seqs = queued.slice(0, 3).map((c) => c.seq);

    expect(await take(dev.serialNo, T0, 2)).toEqual([
      { seq: seqs[0], payload: 'DATA DELETE USERINFO PIN=101' },
      { seq: seqs[1], payload: 'DATA DELETE USERINFO PIN=102' },
    ]);
    expect((await take(dev.serialNo, T0)).map((c) => c.seq)).toEqual([seqs[2]]);
    expect(await take(dev.serialNo, after(4 * MIN))).toEqual([]);
    expect((await commandsOf(a, dev.id)).map((c) => [c.status, c.attempts, c.sentAt])).toEqual([
      ['SENT', 1, T0],
      ['SENT', 1, T0],
      ['SENT', 1, T0],
      ['CANCELLED', 0, null],
    ]);

    // Unanswered: sent again every 5 minutes, 5 times in all.
    for (let attempt = 2; attempt <= 5; attempt++) {
      const now = after((attempt - 1) * 6 * MIN);
      expect((await take(dev.serialNo, now)).map((c) => c.seq)).toEqual(seqs);
    }
    expect(await take(dev.serialNo, after(24 * MIN + 4 * MIN))).toEqual([]);
    expect(await take(dev.serialNo, after(24 * MIN + 6 * MIN))).toEqual([]);
    expect((await commandsOf(a, dev.id)).map((c) => [c.status, c.attempts])).toEqual([
      ['FAILED', 5],
      ['FAILED', 5],
      ['FAILED', 5],
      ['CANCELLED', 0],
    ]);
  });

  it('hands out at most 50 commands at a time', async () => {
    const dev = await addDevice(a);
    await resolve(dev.serialNo);
    await queue(
      a,
      dev.id,
      Array.from({ length: 53 }, (_, i) => String(200 + i)),
    );
    expect(await take(dev.serialNo, T0, -1)).toEqual([]);
    expect(await take(dev.serialNo, T0, 100)).toHaveLength(50);
    expect(await take(dev.serialNo, T0, 1)).toHaveLength(1);
    expect(await take(dev.serialNo, T0, null)).toHaveLength(2);
  });

  it("records a device's answers to its own commands only", async () => {
    const devA = await addDevice(a);
    const devB = await addDevice(b);
    await resolve(devA.serialNo);
    await resolve(devB.serialNo);
    const [ok, bad, pending] = await queue(a, devA.id, ['101', '102', '103']);
    const [commandB] = await queue(b, devB.id, ['101']);
    await take(devA.serialNo, T0, 2);
    await take(devB.serialNo, T0);

    // A's serial cannot complete B's command.
    expect(await answer(devA.serialNo, after(MIN), [{ seq: commandB!.seq, code: 0 }])).toBe(0);
    expect((await commandsOf(b, devB.id)).map((c) => [c.status, c.doneAt])).toEqual([
      ['SENT', null],
    ]);

    expect(
      await answer(devA.serialNo, after(MIN), [
        { seq: ok!.seq, code: 0 },
        { seq: bad!.seq, code: -1 },
        { seq: pending!.seq, code: 0 },
      ]),
    ).toBe(3);
    expect((await commandsOf(a, devA.id)).map((c) => [c.status, c.returnCode, c.doneAt])).toEqual([
      ['DONE', 0, after(MIN)],
      ['FAILED', -1, after(MIN)],
      ['DONE', 0, after(MIN)],
    ]);
    // A finished command does not change again.
    expect(await answer(devA.serialNo, after(2 * MIN), [{ seq: ok!.seq, code: -2 }])).toBe(0);

    const tooMany = Array.from({ length: 201 }, () => ({ seq: ok!.seq, code: 0 }));
    await expect(answer(devA.serialNo, T0, tooMany)).rejects.toThrow(/INGEST_TOO_MANY_RESULTS/);
    await expect(
      ingest.$queryRaw`SELECT ingest_command_results(${devA.serialNo}::text, ${IP}::inet, now(),
        '{"id": 1}'::jsonb)`,
    ).rejects.toThrow(/INGEST_BAD_RESULTS/);
  });
});

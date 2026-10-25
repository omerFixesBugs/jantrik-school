import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { withTenant, type TenantTx } from '@jantrik/db';
import { ZkDeviceSimulator } from '@jantrik/device-sim';
import {
  addDays,
  isoWeekday,
  type AttendanceSettings,
  type DeviceAddress,
  type DeviceAlert,
  type DeviceCommandView,
  type DeviceList,
  type DeviceView,
  type FeedPunch,
  type PunchFeed,
  type TrustAddressResult,
  type UnknownDeviceId,
} from '@jantrik/shared';
import { DEVICES_TENANTS_KEY } from '../src/devices/devices.constants.js';
import { PunchReviewEffects } from '../src/devices/punch-review-effects.js';
import { FakeClock } from './support/clock.js';
import {
  addMember,
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  randomIp,
  type Harness,
} from './support/harness.js';
import { createIngestHarness, type IngestHarness } from './support/ingest.js';
import { school, type School } from './support/school.js';

// The devices screen's API (OWNER/ADMIN). Punches come through the device receiver (driven with
// @jantrik/device-sim), never from the app role, which cannot insert them. Both apps share one
// FakeClock: 2026-10-21 is a Wednesday.

const DAY = '2026-10-21';
/** A Dhaka wall-clock time on DAY as an instant. */
const at = (time: string, day = DAY) => new Date(`${day}T${time}+06:00`);
/** A serial number no earlier run has used: serials are unique across institutes. */
const newSerial = () => `T${randomUUID().replace(/-/g, '').slice(0, 15).toUpperCase()}`;
const TAKEN = {
  statusCode: 409,
  code: 'SERIAL_TAKEN',
  message: "This serial number can't be added; contact Jantrik",
};

describe('devices API', () => {
  const T0 = at('08:00:00');
  const clock = new FakeClock(T0);
  let h: Harness;
  let ingest: IngestHarness;

  beforeAll(async () => {
    h = await createHarness({ clock });
    ingest = await createIngestHarness({ clock });
  });
  afterAll(async () => {
    await ingest.queue.obliterate({ force: true });
    await ingest.close();
    await h.close();
  });
  beforeEach(() => clock.set(T0));
  afterEach(() => vi.restoreAllMocks());

  const inTenant = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) =>
    withTenant(h.prisma, tenantId, fn);
  const get = (token: string, path: string, query: Record<string, string> = {}) =>
    http(h).get(path).query(query).set(bearer(token));
  const post = (token: string, path: string, body: object = {}) =>
    http(h).post(path).set(bearer(token)).send(body);
  const patch = (token: string, id: string, body: object) =>
    http(h).patch(`/attendance/devices/${id}`).set(bearer(token)).send(body);

  /** A bare institute with attendance and one admin. */
  const institute = async (modules: 'ATTENDANCE'[] = ['ATTENDANCE']) => {
    const tenantId = (await createTenant(h, { modules })).id;
    const { phone } = await addMember(h, tenantId, { roles: ['ADMIN'] });
    return { tenantId, admin: (await otpLogin(h, phone)).accessToken };
  };
  const addDevice = async (token: string, body: object = {}) =>
    (
      await post(token, '/attendance/devices', {
        serialNo: newSerial(),
        name: 'Main gate',
        direction: 'BOTH',
        ...body,
      }).expect(201)
    ).body as DeviceView;
  const devices = async (token: string) =>
    ((await get(token, '/attendance/devices').expect(200)).body as DeviceList).devices;
  const feed = async (token: string, query: Record<string, string> = {}) =>
    (await get(token, '/attendance/devices/punches', query).expect(200)).body as PunchFeed;
  const alerts = async (token: string) =>
    (await get(token, '/attendance/devices/alerts').expect(200)).body as DeviceAlert[];
  const putSettings = async (token: string, change: Partial<AttendanceSettings>) => {
    const current = (await get(token, '/attendance/settings').expect(200)).body as object;
    await http(h)
      .put('/attendance/settings')
      .set(bearer(token))
      .send({ ...current, ...change })
      .expect(200);
  };
  const sim = (sn: string, ip = randomIp()) =>
    new ZkDeviceSimulator({ baseUrl: ingest.baseUrl, sn, forwardedFor: ip });
  /** One upload: [pin, Dhaka time, out?] each. */
  const upload = async (device: ZkDeviceSimulator, punches: [string, string, boolean?][]) => {
    const res = await device.uploadAttlog(
      punches.map(([pin, time, out]) => device.attlogLine(pin, at(time), { out })),
    );
    expect(res.status).toBe(200);
  };
  const map = (
    tenantId: string,
    rows: { deviceUserId: string; studentId?: string; staffUserId?: string }[],
  ) =>
    inTenant(tenantId, (tx) =>
      tx.devicePerson.createMany({ data: rows.map((r) => ({ tenantId, ...r })) }),
    );
  const audits = (tenantId: string, entity: string, entityId: string) =>
    inTenant(tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { entity, entityId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { action: true, oldValues: true, newValues: true },
      }),
    );

  describe('access', () => {
    it('teachers, accountants and guardians get 403; so does an institute without attendance', async () => {
      const t = await institute();
      for (const role of ['TEACHER', 'ACCOUNTANT', 'GUARDIAN'] as const) {
        const { phone } = await addMember(h, t.tenantId, { roles: [role] });
        const token = (await otpLogin(h, phone)).accessToken;
        await get(token, '/attendance/devices').expect(403);
        await get(token, '/attendance/devices/punches').expect(403);
        await post(token, '/attendance/devices', { serialNo: newSerial() }).expect(403);
      }
      const off = await institute([]);
      await get(off.admin, '/attendance/devices').expect(403);
      await get(off.admin, '/attendance/devices/alerts').expect(403);
    });
  });

  describe('devices', () => {
    it('adds a device: serial trimmed and upper-cased, audited, institute listed for the daily jobs', async () => {
      const t = await institute();
      const serial = newSerial();
      const device = await addDevice(t.admin, {
        serialNo: `  ${serial.toLowerCase()} `,
        gate: ' North ',
        direction: 'IN',
      });
      expect(device).toMatchObject({
        brand: 'ZKTECO',
        serialNo: serial,
        name: 'Main gate',
        gate: 'North',
        direction: 'IN',
        isActive: true,
        state: 'NEVER_CONNECTED',
        lastSeenAt: null,
        pendingCommands: 0,
        failedCommands: 0,
        untrustedAddresses: 0,
        clockWarning: false,
        createdAt: T0.toISOString(),
      });
      expect(await audits(t.tenantId, 'attendance_device', device.id)).toEqual([
        {
          action: 'CREATE',
          oldValues: null,
          newValues: {
            brand: 'ZKTECO',
            serialNo: serial,
            name: 'Main gate',
            gate: 'North',
            direction: 'IN',
            isActive: true,
          },
        },
      ]);
      expect(await h.redis.zscore(DEVICES_TENANTS_KEY, t.tenantId)).toBe(String(T0.getTime()));
      await post(t.admin, '/attendance/devices', { serialNo: 'AB-1234', name: 'x' }).expect(400);
    });

    it("a serial active anywhere is SERIAL_TAKEN with nothing about whose; free again once it's off", async () => {
      const a = await institute();
      const b = await institute();
      const serial = newSerial();
      const mine = await addDevice(a.admin, { serialNo: serial });
      for (const token of [a.admin, b.admin]) {
        const res = await post(token, '/attendance/devices', {
          serialNo: serial,
          name: 'Gate',
          direction: 'IN',
        }).expect(409);
        expect(res.body).toEqual(TAKEN);
      }
      await patch(a.admin, mine.id, { isActive: false }).expect(200);
      const theirs = await addDevice(b.admin, { serialNo: serial });
      expect(theirs.serialNo).toBe(serial);
      // Switching the first one back on would make the serial active twice.
      expect((await patch(a.admin, mine.id, { isActive: true }).expect(409)).body).toEqual(TAKEN);
      // Nor can another device of A take it.
      const other = await addDevice(a.admin);
      expect((await patch(a.admin, other.id, { serialNo: serial }).expect(409)).body).toEqual(
        TAKEN,
      );
      expect((await devices(b.admin)).map((d) => d.id)).toEqual([theirs.id]);
    });

    it('edits are audited with old and new values; a connected device keeps its serial', async () => {
      const t = await institute();
      const device = await addDevice(t.admin);
      const renamed = (
        await patch(t.admin, device.id, { name: ' Back gate ', gate: 'East', direction: 'OUT' })
      ).body as DeviceView;
      expect(renamed).toMatchObject({ name: 'Back gate', gate: 'East', direction: 'OUT' });
      // A new serial is fine while the device has never called in.
      const serial = newSerial();
      await patch(t.admin, device.id, { serialNo: serial.toLowerCase(), gate: '' }).expect(200);
      expect(await audits(t.tenantId, 'attendance_device', device.id)).toEqual([
        expect.objectContaining({ action: 'CREATE' }),
        {
          action: 'UPDATE',
          oldValues: { name: 'Main gate', gate: null, direction: 'BOTH' },
          newValues: { name: 'Back gate', gate: 'East', direction: 'OUT' },
        },
        {
          action: 'UPDATE',
          oldValues: { gate: 'East', serialNo: device.serialNo },
          newValues: { gate: null, serialNo: serial },
        },
      ]);

      expect((await sim(serial).handshake()).status).toBe(200);
      const locked = await patch(t.admin, device.id, { serialNo: newSerial() }).expect(409);
      expect(locked.body.code).toBe('SERIAL_LOCKED');
      // Sending the same serial again changes nothing (and writes no audit row).
      await patch(t.admin, device.id, { serialNo: serial, name: 'Back gate' }).expect(200);
      expect(await audits(t.tenantId, 'attendance_device', device.id)).toHaveLength(3);
      await patch(t.admin, randomUUID(), { name: 'x' }).expect(404);
    });

    it('states by the clock (online up to 120 s), the setup address and the counts', async () => {
      const t = await institute();
      clock.set(at('07:59:58'));
      const online = await addDevice(t.admin, { name: 'A' });
      clock.advance(1000);
      const never = await addDevice(t.admin, { name: 'B' });
      const off = await addDevice(t.admin, { name: 'C' });
      await patch(t.admin, off.id, { isActive: false }).expect(200);
      clock.set(T0);
      const ip = randomIp();
      expect((await sim(online.serialNo, ip).handshake()).status).toBe(200);
      // A second address: recorded, not trusted.
      expect((await sim(online.serialNo).ping()).status).toBe(200);

      clock.advance(119_000);
      const list = (await get(t.admin, '/attendance/devices').expect(200)).body as DeviceList;
      const config = h.app.get(ConfigService);
      expect(list.setup).toEqual({
        host: config.get('INGEST_PUBLIC_HOST'),
        port: config.get('INGEST_PUBLIC_PORT'),
      });
      expect(list.devices.map((d) => [d.name, d.state])).toEqual([
        ['A', 'ONLINE'],
        ['B', 'NEVER_CONNECTED'],
        ['C', 'INACTIVE'],
      ]);
      expect(list.devices[0]).toMatchObject({
        lastSeenAt: T0.toISOString(),
        lastIp: expect.any(String),
        pushVersion: '2.4.1',
        untrustedAddresses: 1,
      });
      clock.advance(2_000);
      expect((await devices(t.admin)).map((d) => d.state)).toEqual([
        'OFFLINE',
        'NEVER_CONNECTED',
        'INACTIVE',
      ]);
      expect(never.state).toBe('NEVER_CONNECTED');
    });
  });

  describe('sync and commands', () => {
    it('queues every active person once, skips identical waiting ones, ignores inactive people', async () => {
      const s = await school(h, { settings: { absentSmsEnabled: false } });
      const device = await addDevice(s.admin);
      const staff = await addMember(h, s.tenantId, { roles: ['TEACHER'], name: 'Gate Keeper' });
      const gone = await addMember(h, s.tenantId, { roles: ['TEACHER'], name: 'Gone Teacher' });
      const b0Code = await inTenant(s.tenantId, async (tx) => {
        await tx.membership.updateMany({
          where: { userId: gone.userId },
          data: { status: 'DISABLED' },
        });
        await tx.student.update({ where: { id: s.a[2]!.id }, data: { status: 'INACTIVE' } });
        return (await tx.student.update({ where: { id: s.b[0]!.id }, data: { nameEn: null } }))
          .studentCode;
      });
      await map(s.tenantId, [
        { deviceUserId: '101', studentId: s.a[0]!.id },
        { deviceUserId: '103', studentId: s.a[2]!.id },
        { deviceUserId: '201', studentId: s.b[0]!.id },
        { deviceUserId: '9001', staffUserId: staff.userId },
        { deviceUserId: '9002', staffUserId: gone.userId },
      ]);

      const sync = () => post(s.admin, `/attendance/devices/${device.id}/sync`).expect(200);
      expect((await sync()).body).toEqual({ queued: 3, skipped: 0 });
      const payloads = await inTenant(s.tenantId, (tx) =>
        tx.deviceCommand.findMany({ where: { deviceId: device.id }, orderBy: { seq: 'asc' } }),
      );
      expect(payloads.map((p) => p.payload)).toEqual([
        'DATA UPDATE USERINFO PIN=101\tName=Student 1',
        // No English name: the student code.
        `DATA UPDATE USERINFO PIN=201\tName=${b0Code}`,
        'DATA UPDATE USERINFO PIN=9001\tName=Gate Keeper',
      ]);
      expect(await audits(s.tenantId, 'device_command', device.id)).toEqual([
        {
          action: 'CREATE',
          oldValues: null,
          newValues: { kind: 'USER_UPSERT', queued: 3, skipped: 0 },
        },
      ]);

      expect((await sync()).body).toEqual({ queued: 0, skipped: 3 });
      // A changed name is a different command.
      await inTenant(s.tenantId, (tx) =>
        tx.student.update({ where: { id: s.a[0]!.id }, data: { nameEn: 'Renamed One' } }),
      );
      expect((await sync()).body).toEqual({ queued: 1, skipped: 2 });

      const commands = (await get(s.admin, `/attendance/devices/${device.id}/commands`).expect(200))
        .body as DeviceCommandView[];
      expect(commands.map((c) => c.deviceUserId)).toEqual(['101', '9001', '201', '101']);
      expect(commands[0]).toEqual({
        seq: expect.stringMatching(/^\d+$/),
        kind: 'USER_UPSERT',
        deviceUserId: '101',
        status: 'PENDING',
        attempts: 0,
        sentAt: null,
        doneAt: null,
        returnCode: null,
      });
      expect(BigInt(commands[0]!.seq)).toBeGreaterThan(BigInt(commands[1]!.seq));
      expect(JSON.stringify(commands)).not.toContain('Name=');
      for (const [status, n] of [
        ['PENDING', 4],
        ['FAILED', 0],
      ] as const) {
        const res = await get(s.admin, `/attendance/devices/${device.id}/commands`, { status });
        expect(res.body).toHaveLength(n);
      }
      expect((await devices(s.admin))[0]).toMatchObject({ pendingCommands: 4, failedCommands: 0 });

      await patch(s.admin, device.id, { isActive: false }).expect(200);
      const inactive = await post(s.admin, `/attendance/devices/${device.id}/sync`).expect(409);
      expect(inactive.body.code).toBe('DEVICE_INACTIVE');
    });
  });

  describe('punch feed', () => {
    let s: School;
    let device: DeviceView;
    let reader: ZkDeviceSimulator;
    let staffUserId: string;

    beforeAll(async () => {
      clock.set(T0);
      s = await school(h, { settings: { absentSmsEnabled: false } });
      device = await addDevice(s.admin, { name: 'Front', gate: 'North' });
      // Section B starts at 09:00 (its shift); section A has none: "school starts at" 08:00.
      await inTenant(s.tenantId, async (tx) => {
        const shift = await tx.shift.create({
          data: {
            tenantId: s.tenantId,
            nameBn: 'দিবা',
            nameEn: 'Day',
            startTime: new Date('1970-01-01T09:00:00Z'),
            endTime: new Date('1970-01-01T13:00:00Z'),
          },
        });
        await tx.section.update({ where: { id: s.sectionB }, data: { shiftId: shift.id } });
      });
      // The staff member's global name differs from what this institute typed.
      const staff = await addMember(h, s.tenantId, { roles: ['TEACHER'], name: 'Global Name' });
      staffUserId = staff.userId;
      await inTenant(s.tenantId, (tx) =>
        tx.staffProfile.update({
          where: { tenantId_userId: { tenantId: s.tenantId, userId: staff.userId } },
          data: { name: 'Gate Keeper', nameBn: 'দারোয়ান' },
        }),
      );
      await map(s.tenantId, [
        { deviceUserId: '101', studentId: s.a[0]!.id },
        { deviceUserId: '102', studentId: s.a[1]!.id },
        { deviceUserId: '201', studentId: s.b[0]!.id },
        { deviceUserId: '9001', staffUserId: staff.userId },
      ]);
      clock.set(at('09:30:00'));
      reader = sim(device.serialNo);
      await upload(reader, [
        ['101', '08:10:00'],
        ['102', '08:10:01'],
        ['9001', '08:15:00'],
        ['101', '08:20:00', true],
        ['555', '08:30:00'],
        ['201', '09:05:00'],
      ]);
    });

    it('people from students and staff profiles, unknown IDs unmapped, arrival on time or late', async () => {
      // The devices worker processes the upload (its job waits a second): the outcome is settled.
      await vi.waitFor(
        async () => {
          const left = await inTenant(s.tenantId, (tx) =>
            tx.devicePunch.count({ where: { processedAt: null } }),
          );
          if (left > 0) throw new Error('not processed yet');
        },
        { timeout: 10_000, interval: 100 },
      );
      const { punches } = await feed(s.admin);
      expect(
        punches.map((p) => [
          p.deviceUserId,
          p.direction,
          p.person?.kind === 'STAFF' ? p.person.name : (p.person?.nameEn ?? null),
          p.arrival,
        ]),
      ).toEqual([
        ['201', 'IN', 'Student 1', 'PRESENT'], // section B: its shift starts at 09:00
        ['555', 'IN', null, null],
        ['101', 'OUT', 'Student 1', null],
        ['9001', 'IN', 'Gate Keeper', null],
        ['102', 'IN', 'Student 2', 'LATE'], // 08:10:01 > 08:00 + 10 minutes
        ['101', 'IN', 'Student 1', 'PRESENT'], // 08:10:00 is still on time
      ]);
      const classLevel = await inTenant(
        s.tenantId,
        async (tx) =>
          (
            await tx.section.findUniqueOrThrow({
              where: { id: s.sectionA },
              select: { classLevel: { select: { id: true, nameBn: true, nameEn: true } } },
            })
          ).classLevel,
      );
      expect(punches[5]).toEqual({
        id: expect.any(String),
        device: { id: device.id, name: 'Front', gate: 'North' },
        deviceUserId: '101',
        punchedAt: at('08:10:00').toISOString(),
        receivedAt: at('09:30:00').toISOString(),
        localDate: DAY,
        direction: 'IN',
        verifyKind: 'FINGERPRINT',
        flags: [],
        review: null,
        outcome: 'APPLIED',
        person: {
          kind: 'STUDENT',
          id: s.a[0]!.id,
          nameBn: 'ছাত্র 1',
          nameEn: 'Student 1',
          studentCode: expect.any(String),
          classLevel,
          section: { id: s.sectionA, name: 'A' },
        },
        arrival: 'PRESENT',
      });
      expect(punches[3]!.person).toEqual({
        kind: 'STAFF',
        userId: staffUserId,
        name: 'Gate Keeper',
        nameBn: 'দারোয়ান',
      });
      expect(JSON.stringify(punches)).not.toContain('Global Name');
    });

    it('a cursor returns only newer punches; limit and device filter', async () => {
      const first = await feed(s.admin);
      expect(first.cursor).toMatch(/^\d+_/);
      clock.set(at('09:31:00'));
      await upload(reader, [['102', '09:30:30']]);
      const next = await feed(s.admin, { after: first.cursor! });
      expect(next.punches.map((p) => [p.deviceUserId, p.punchedAt])).toEqual([
        ['102', at('09:30:30').toISOString()],
      ]);
      expect(next.cursor).not.toBe(first.cursor);
      expect(await feed(s.admin, { after: next.cursor! })).toEqual({
        punches: [],
        cursor: next.cursor,
      });
      expect((await feed(s.admin, { limit: '2' })).punches.map((p) => p.deviceUserId)).toEqual([
        '102',
        '201',
      ]);
      const other = await addDevice(s.admin, { name: 'Back' });
      clock.set(at('09:32:00'));
      await upload(sim(other.serialNo), [['555', '09:31:00']]);
      const only = await feed(s.admin, { deviceId: other.id });
      expect(only.punches.map((p) => [p.device.name, p.deviceUserId])).toEqual([['Back', '555']]);
      await get(s.admin, '/attendance/devices/punches', { after: 'nope' }).expect(400);
      await get(s.admin, '/attendance/devices/punches', { limit: '101' }).expect(400);
    });

    it('flagged: NEW_IP, OUTSIDE_HOURS or BURST without a review; other flags are not', async () => {
      clock.set(at('09:40:00'));
      // Another address: NEW_IP. Before 05:00: OUTSIDE_HOURS. Ten minutes ahead: CLOCK_FUTURE.
      await upload(sim(device.serialNo), [['101', '09:39:00']]);
      await upload(reader, [
        ['102', '04:30:00'],
        ['201', '09:50:00'],
      ]);
      const flagged = await feed(s.admin, { flagged: '1' });
      expect(flagged.punches.map((p) => [p.deviceUserId, p.flags])).toEqual([
        ['101', ['NEW_IP']],
        ['102', ['OUTSIDE_HOURS']],
      ]);
      const all = await feed(s.admin, { limit: '3' });
      expect(all.punches.find((p) => p.deviceUserId === '201')?.flags).toEqual(['CLOCK_FUTURE']);
      await post(s.admin, `/attendance/devices/punches/${flagged.punches[0]!.id}/review`, {
        action: 'OK',
      }).expect(200);
      expect((await feed(s.admin, { flagged: '1' })).punches.map((p) => p.deviceUserId)).toEqual([
        '102',
      ]);
    });
  });

  describe('review', () => {
    it('OK, ACCEPT only for a held punch, REJECT; the last decision wins; audited; the hook runs', async () => {
      const t = await institute();
      await putSettings(t.admin, { deviceMaxPunchesPerMinute: 10 });
      const device = await addDevice(t.admin);
      clock.set(at('08:05:00'));
      // Eleven punches stamped in one minute: the eleventh is held (BURST).
      await upload(
        sim(device.serialNo),
        Array.from({ length: 11 }, (_, i) => [
          String(101 + i),
          `08:01:${String(i).padStart(2, '0')}`,
        ]),
      );
      const { punches } = await feed(t.admin);
      const held = punches.find((p) => p.flags.includes('BURST'))!;
      const plain = punches.find((p) => p.flags.length === 0)!;
      expect(held.deviceUserId).toBe('111');

      const effects = vi.spyOn(h.app.get(PunchReviewEffects), 'afterReview');
      const review = (id: string, action: string) =>
        post(t.admin, `/attendance/devices/punches/${id}/review`, { action });
      const notHeld = await review(plain.id, 'ACCEPT').expect(422);
      expect(notHeld.body.code).toBe('NOT_HELD');
      await review(plain.id, 'MAYBE').expect(400);

      clock.set(at('08:10:00'));
      const accepted = (await review(held.id, 'ACCEPT').expect(200)).body as FeedPunch;
      expect(accepted).toMatchObject({ id: held.id, review: 'ACCEPTED', flags: ['BURST'] });
      expect((await review(held.id, 'REJECT').expect(200)).body.review).toBe('REJECTED');
      expect((await review(held.id, 'OK').expect(200)).body.review).toBe('OK');
      expect((await review(plain.id, 'REJECT').expect(200)).body.review).toBe('REJECTED');

      const row = await inTenant(t.tenantId, (tx) =>
        tx.devicePunch.findUniqueOrThrow({ where: { id: held.id } }),
      );
      expect(row).toMatchObject({ review: 'OK', reviewedAt: at('08:10:00') });
      expect(row.reviewedById).toEqual(expect.any(String));
      expect(await audits(t.tenantId, 'device_punch', held.id)).toEqual([
        { action: 'UPDATE', oldValues: { review: null }, newValues: { review: 'ACCEPTED' } },
        { action: 'UPDATE', oldValues: { review: 'ACCEPTED' }, newValues: { review: 'REJECTED' } },
        { action: 'UPDATE', oldValues: { review: 'REJECTED' }, newValues: { review: 'OK' } },
      ]);
      expect(effects.mock.calls.map(([p]) => [p.id, p.previousReview, p.review])).toEqual([
        [held.id, null, 'ACCEPTED'],
        [held.id, 'ACCEPTED', 'REJECTED'],
        [held.id, 'REJECTED', 'OK'],
        [plain.id, null, 'REJECTED'],
      ]);
      expect(effects.mock.calls[0]![0]).toMatchObject({
        deviceUserId: '111',
        localDate: DAY,
        flags: ['BURST'],
      });
      await review(randomUUID(), 'OK').expect(404);
    });

    it('the flagged view looks back 7 days; older flagged punches stay in the feed', async () => {
      const t = await institute();
      // Registered 9 days ago, so it may upload then.
      clock.set(at('08:00:00', addDays(DAY, -9)));
      const device = await addDevice(t.admin);
      const reader = sim(device.serialNo);
      // Before 05:00: OUTSIDE_HOURS, received 8 days, 7 days and 0 days ago.
      for (const days of [-8, -7, 0]) {
        const day = addDays(DAY, days);
        clock.set(at('08:00:00', day));
        const res = await reader.uploadAttlog([reader.attlogLine('101', at('04:30:00', day))]);
        expect(res.status).toBe(200);
      }
      const dayOf = (p: FeedPunch) => p.localDate;
      expect((await feed(t.admin, { flagged: '1' })).punches.map(dayOf)).toEqual([
        DAY,
        addDays(DAY, -7), // exactly 7 days ago: still in
      ]);
      expect((await feed(t.admin)).punches.map(dayOf)).toEqual([
        DAY,
        addDays(DAY, -7),
        addDays(DAY, -8),
      ]);
      expect((await feed(t.admin)).punches.every((p) => p.flags.includes('OUTSIDE_HOURS'))).toBe(
        true,
      );
    });
  });

  describe('source addresses', () => {
    it('the first address is trusted automatically; trusting another marks its NEW_IP punches OK; revoking flags again', async () => {
      const t = await institute();
      const device = await addDevice(t.admin);
      const homeIp = randomIp();
      const home = sim(device.serialNo, homeIp);
      clock.set(at('08:05:00'));
      await upload(home, [['101', '08:01:00']]);
      const awayIp = randomIp();
      clock.set(at('08:06:00'));
      await upload(sim(device.serialNo, awayIp), [
        ['102', '08:02:00'],
        ['103', '08:03:00'],
      ]);
      const ips = (await get(t.admin, `/attendance/devices/${device.id}/ips`).expect(200))
        .body as DeviceAddress[];
      expect(ips).toEqual([
        {
          id: expect.any(String),
          ip: awayIp,
          firstSeenAt: at('08:06:00').toISOString(),
          lastSeenAt: at('08:06:00').toISOString(),
          punchCount: 2,
          trusted: false,
          trustedAt: null,
          trustedBy: null,
        },
        {
          id: expect.any(String),
          ip: homeIp,
          firstSeenAt: at('08:05:00').toISOString(),
          lastSeenAt: at('08:05:00').toISOString(),
          punchCount: 1,
          trusted: true,
          trustedAt: at('08:05:00').toISOString(),
          trustedBy: 'automatic',
        },
      ]);
      expect((await feed(t.admin, { flagged: '1' })).punches.map((p) => p.deviceUserId)).toEqual([
        '103',
        '102',
      ]);

      clock.set(at('08:20:00'));
      const trusted = (
        await post(t.admin, `/attendance/devices/${device.id}/ips/${ips[0]!.id}/trust`).expect(200)
      ).body as TrustAddressResult;
      expect(trusted).toEqual({
        address: {
          ...ips[0],
          trusted: true,
          trustedAt: at('08:20:00').toISOString(),
          trustedBy: { id: expect.any(String), name: 'Test User', nameBn: null },
        },
        reviewedPunches: 2,
      });
      const { punches } = await feed(t.admin);
      expect(punches.map((p) => [p.deviceUserId, p.review])).toEqual([
        ['103', 'OK'],
        ['102', 'OK'],
        ['101', null],
      ]);
      expect(await feed(t.admin, { flagged: '1' })).toMatchObject({ punches: [] });
      expect(await audits(t.tenantId, 'device_source_ip', ips[0]!.id)).toEqual([
        {
          action: 'UPDATE',
          oldValues: { ip: awayIp, trustedAt: null, trustedById: null },
          newValues: {
            ip: awayIp,
            trustedAt: at('08:20:00').toISOString(),
            trustedById: (trusted.address.trustedBy as { id: string }).id,
            reviewedPunches: 2,
          },
        },
      ]);

      // The automatically trusted address may have been a squatter's: revoke it.
      const revoked = (
        await post(t.admin, `/attendance/devices/${device.id}/ips/${ips[1]!.id}/revoke`).expect(200)
      ).body as DeviceAddress;
      expect(revoked).toMatchObject({
        ip: homeIp,
        trusted: false,
        trustedAt: null,
        trustedBy: null,
      });
      expect(await audits(t.tenantId, 'device_source_ip', ips[1]!.id)).toEqual([
        {
          action: 'UPDATE',
          oldValues: { ip: homeIp, trustedAt: at('08:05:00').toISOString(), trustedById: null },
          newValues: { ip: homeIp, trustedAt: null, trustedById: null },
        },
      ]);
      clock.set(at('08:21:00'));
      await upload(home, [['104', '08:20:30']]);
      expect(
        (await feed(t.admin, { flagged: '1' })).punches.map((p) => [p.deviceUserId, p.flags]),
      ).toEqual([['104', ['NEW_IP']]]);

      // An address of another device is not this device's.
      const other = await addDevice(t.admin);
      await post(t.admin, `/attendance/devices/${other.id}/ips/${ips[0]!.id}/trust`).expect(404);
      await post(t.admin, `/attendance/devices/${other.id}/ips/${ips[0]!.id}/revoke`).expect(404);
    });
  });

  describe('unknown IDs', () => {
    it('IDs that punched in the last 30 days and belong to nobody', async () => {
      const s = await school(h, { settings: { absentSmsEnabled: false } });
      // Registered 40 days ago, so it may upload a punch from 35 days ago.
      clock.set(at('08:00:00', addDays(DAY, -40)));
      const front = await addDevice(s.admin, { name: 'Front' });
      const back = await addDevice(s.admin, { name: 'Back' });
      await map(s.tenantId, [{ deviceUserId: '101', studentId: s.a[0]!.id }]);
      clock.set(at('09:00:00'));
      const frontSim = sim(front.serialNo);
      await frontSim.uploadAttlog([
        frontSim.attlogLine('777', at('08:00:00', addDays(DAY, -35))),
        frontSim.attlogLine('777', at('08:00:00', addDays(DAY, -29))),
        frontSim.attlogLine('101', at('08:01:00')),
        frontSim.attlogLine('888', at('08:02:00')),
      ]);
      clock.set(at('09:01:00'));
      await upload(sim(back.serialNo), [['777', '08:30:00']]);
      const unknown = (await get(s.admin, '/attendance/devices/unknown-ids').expect(200))
        .body as UnknownDeviceId[];
      expect(unknown).toEqual([
        {
          deviceUserId: '777',
          lastPunchAt: at('08:30:00').toISOString(),
          count: 2,
          lastDeviceName: 'Back',
        },
        {
          deviceUserId: '888',
          lastPunchAt: at('08:02:00').toISOString(),
          count: 1,
          lastDeviceName: 'Front',
        },
      ]);
    });
  });

  describe('alerts', () => {
    it('OFFLINE: more than 10 minutes, on working days, from an hour before the earliest start to office end', async () => {
      const t = await institute();
      await putSettings(t.admin, { weeklyOffDays: [] });
      clock.set(at('05:00:00'));
      const never = await addDevice(t.admin, { name: 'Never' });
      clock.advance(1000);
      const seen = await addDevice(t.admin, { name: 'Seen' });
      const off = await addDevice(t.admin, { name: 'Off' });
      await patch(t.admin, off.id, { isActive: false }).expect(200);

      const offline = async () =>
        (await alerts(t.admin)).filter((a) => a.kind === 'OFFLINE').map((a) => a.deviceName);
      clock.set(at('06:59:59'));
      expect(await offline()).toEqual([]); // before 07:00 (school starts at 08:00, less an hour)
      clock.set(at('07:00:00'));
      await sim(seen.serialNo).handshake();
      clock.set(at('07:05:00'));
      expect(await alerts(t.admin)).toEqual([
        {
          kind: 'OFFLINE',
          deviceId: never.id,
          deviceName: 'Never',
          state: 'NEVER_CONNECTED',
          since: at('05:00:00').toISOString(),
        },
      ]);
      clock.set(at('07:10:00'));
      expect(await offline()).toEqual(['Never']); // seen 10 minutes ago: not yet
      clock.set(at('07:10:01'));
      expect(await alerts(t.admin)).toContainEqual({
        kind: 'OFFLINE',
        deviceId: seen.id,
        deviceName: 'Seen',
        state: 'OFFLINE',
        since: at('07:00:00').toISOString(),
      });
      clock.set(at('16:00:00'));
      expect(await offline()).toEqual(['Never', 'Seen']);
      clock.set(at('16:00:01'));
      expect(await offline()).toEqual([]); // the office has closed

      // The next day (a Thursday): an earlier shift moves the start, a later office end the end.
      const next = addDays(DAY, 1);
      clock.set(at('06:00:00', next));
      expect(await offline()).toEqual([]);
      await inTenant(t.tenantId, (tx) =>
        tx.shift.create({
          data: {
            tenantId: t.tenantId,
            nameBn: 'প্রভাতী',
            nameEn: 'Morning',
            startTime: new Date('1970-01-01T06:30:00Z'),
            endTime: new Date('1970-01-01T11:00:00Z'),
          },
        }),
      );
      expect(await offline()).toEqual(['Never', 'Seen']);
      clock.set(at('16:30:00', next));
      expect(await offline()).toEqual([]);
      await putSettings(t.admin, { staffOfficeEnd: '17:00' });
      expect(await offline()).toEqual(['Never', 'Seen']);

      // Not on a weekly off day, nor on a holiday.
      clock.set(at('09:00:00', next));
      await putSettings(t.admin, { weeklyOffDays: [isoWeekday(next)] });
      expect(await offline()).toEqual([]);
      await putSettings(t.admin, { weeklyOffDays: [] });
      expect(await offline()).toEqual(['Never', 'Seen']);
      await inTenant(t.tenantId, (tx) =>
        tx.holiday.create({
          data: {
            tenantId: t.tenantId,
            startDate: new Date(`${next}T00:00:00Z`),
            endDate: new Date(`${next}T00:00:00Z`),
            nameBn: 'ছুটি',
            nameEn: 'Holiday',
          },
        }),
      );
      expect(await offline()).toEqual([]);
    });

    it('NEW_IP, FLOOD, HELD and CLOCK', async () => {
      const t = await institute();
      // Wednesdays and Thursdays off keep OFFLINE out of this test.
      await putSettings(t.admin, {
        weeklyOffDays: [isoWeekday(DAY), isoWeekday(addDays(DAY, 1))],
        deviceMaxPunchesPerMinute: 10,
      });
      const gate = await addDevice(t.admin, { name: 'Gate' });
      const home = sim(gate.serialNo);
      clock.set(at('08:05:00'));
      // 55 punches stamped in one minute with a cap of 10: 10 count, 40 are held, 5 dropped.
      await upload(
        home,
        Array.from({ length: 55 }, (_, i) => [
          String(101 + i),
          `08:01:${String(i).padStart(2, '0')}`,
        ]),
      );
      const awayIp = randomIp();
      await upload(sim(gate.serialNo, awayIp), [['999', '08:04:00']]);
      // An address that never sent a punch is no alert.
      await sim(gate.serialNo).ping();

      const listed = await alerts(t.admin);
      const ipId = (listed.find((a) => a.kind === 'NEW_IP') as { ipId: string } | undefined)?.ipId;
      expect(listed).toEqual([
        {
          kind: 'NEW_IP',
          deviceId: gate.id,
          deviceName: 'Gate',
          ipId: expect.any(String),
          ip: awayIp,
          punchCount: 1,
          lastSeenAt: at('08:05:00').toISOString(),
        },
        {
          kind: 'FLOOD',
          deviceId: gate.id,
          deviceName: 'Gate',
          at: at('08:05:00').toISOString(),
          dropped: 5,
        },
        { kind: 'HELD', deviceId: gate.id, deviceName: 'Gate', count: 40 },
      ]);

      await post(t.admin, `/attendance/devices/${gate.id}/ips/${ipId}/trust`).expect(200);
      const held = (await feed(t.admin, { flagged: '1', limit: '1' })).punches[0]!;
      await post(t.admin, `/attendance/devices/punches/${held.id}/review`, {
        action: 'ACCEPT',
      }).expect(200);
      expect((await alerts(t.admin)).map((a) => [a.kind, 'count' in a ? a.count : null])).toEqual([
        ['FLOOD', null],
        ['HELD', 39],
      ]);
      // A day later the flood is old news; a week later so are the held punches.
      clock.set(at('08:05:01', addDays(DAY, 1)));
      expect((await alerts(t.admin)).map((a) => a.kind)).toEqual(['HELD']);
      clock.set(at('08:05:01', addDays(DAY, 7)));
      expect(await alerts(t.admin)).toEqual([]);
    });

    it('CLOCK: a device clock four minutes ahead; nothing for switched-off devices', async () => {
      const t = await institute();
      await putSettings(t.admin, { weeklyOffDays: [isoWeekday(DAY)] });
      const fast = await addDevice(t.admin, { name: 'Fast' });
      const device = sim(fast.serialNo);
      await device.handshake();
      // Three real-time uploads that agree: the device is 240 s ahead.
      for (let i = 0; i < 3; i++) {
        clock.advance(30_000);
        const res = await device.punch(String(101 + i), {
          at: new Date(clock.now().getTime() + 240_000),
        });
        expect(res.status).toBe(200);
      }
      expect(await alerts(t.admin)).toEqual([
        { kind: 'CLOCK', deviceId: fast.id, deviceName: 'Fast', minutes: 4, ahead: true },
      ]);
      expect((await devices(t.admin))[0]).toMatchObject({
        clockOffsetSec: 240,
        clockWarning: true,
      });
      await patch(t.admin, fast.id, { isActive: false }).expect(200);
      expect(await alerts(t.admin)).toEqual([]);
    });
  });

  it("institute B sees none of A's devices, punches or addresses, and gets 404 on A's ids", async () => {
    const a = await institute();
    const b = await institute();
    const device = await addDevice(a.admin);
    clock.set(at('08:05:00'));
    await upload(sim(device.serialNo), [['101', '08:01:00']]);
    await upload(sim(device.serialNo), [['102', '08:02:00']]);
    const ips = (await get(a.admin, `/attendance/devices/${device.id}/ips`).expect(200))
      .body as DeviceAddress[];
    const punch = (await feed(a.admin)).punches[0]!;
    expect(ips).toHaveLength(2);

    expect(await devices(b.admin)).toEqual([]);
    expect(await feed(b.admin)).toEqual({ punches: [], cursor: null });
    expect(await feed(b.admin, { deviceId: device.id })).toEqual({ punches: [], cursor: null });
    expect((await get(b.admin, '/attendance/devices/unknown-ids').expect(200)).body).toEqual([]);
    expect(await alerts(b.admin)).toEqual([]);
    const base = `/attendance/devices/${device.id}`;
    await patch(b.admin, device.id, { name: 'Mine now' }).expect(404);
    await post(b.admin, `${base}/sync`).expect(404);
    await get(b.admin, `${base}/commands`).expect(404);
    await get(b.admin, `${base}/ips`).expect(404);
    await post(b.admin, `${base}/ips/${ips[0]!.id}/trust`).expect(404);
    await post(b.admin, `${base}/ips/${ips[1]!.id}/revoke`).expect(404);
    await post(b.admin, `/attendance/devices/punches/${punch.id}/review`, {
      action: 'REJECT',
    }).expect(404);
    // Nothing of A's changed.
    expect((await devices(a.admin))[0]).toMatchObject({ name: 'Main gate', untrustedAddresses: 1 });
    expect((await feed(a.admin)).punches.map((p) => p.review)).toEqual([null, null]);
  });
});

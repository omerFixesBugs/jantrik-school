import { randomUUID } from 'node:crypto';
import { withTenant, type Role, type TenantTx } from '@jantrik/db';
import { ZkDeviceSimulator } from '@jantrik/device-sim';
import {
  dateToDb,
  type AttendanceSettings,
  type AttendanceStatus,
  type IsoDate,
} from '@jantrik/shared';
import { processPunchesJobId } from '../../src/devices/devices.constants.js';
import type { FakeClock } from './clock.js';
import { addMember, bearer, http, randomIp, type Harness } from './harness.js';
import type { IngestHarness } from './ingest.js';
import { school, type School } from './school.js';

/** A Dhaka wall-clock time on `day` as an instant. */
export const dhaka = (day: IsoDate, time: string) => new Date(`${day}T${time}+06:00`);

/** A serial number no earlier run has used: serials are unique across institutes. */
const newSerial = () => `T${randomUUID().replace(/-/g, '').slice(0, 15).toUpperCase()}`;

export type Institute = School & { device: { id: string; serialNo: string } };

/**
 * Fixtures for punch processing. The API harness (with its devices worker) and the device receiver
 * share one FakeClock; punches come through the receiver, driven with @jantrik/device-sim.
 * Devices are added as rows, not through the API, so their institutes are not in
 * `devices:tenants` until their first process-punches job runs; tests that run the tick or
 * retention over the whole set clear it first.
 */
export function punchFixtures(h: () => Harness, ingest: () => IngestHarness, clock: FakeClock) {
  const inTenant = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) =>
    withTenant(h().prisma, tenantId, fn);

  /** A device registered `registeredAgoMs` ago (default an hour: its first address is trusted). */
  const addDevice = (tenantId: string, registeredAgoMs = 3600_000) =>
    inTenant(tenantId, (tx) =>
      tx.attendanceDevice.create({
        data: {
          tenantId,
          serialNo: newSerial(),
          name: 'Gate',
          direction: 'BOTH',
          createdAt: new Date(clock.now().getTime() - registeredAgoMs),
        },
        select: { id: true, serialNo: true },
      }),
    );

  /** A school (support/school.ts: absent SMS on with no delay, no off days) and a device. */
  const institute = async (
    settings: Partial<AttendanceSettings> = {},
    opts: { registeredAgoMs?: number } = {},
  ): Promise<Institute> => {
    const s = await school(h(), { settings });
    return { ...s, device: await addDevice(s.tenantId, opts.registeredAgoMs) };
  };

  /** The device seen from one source address (a new address each call unless given). */
  const sim = (serialNo: string, ip = randomIp()) =>
    new ZkDeviceSimulator({ baseUrl: ingest().baseUrl, sn: serialNo, forwardedFor: ip });

  /** One upload of [pin, Dhaka time, out?] on `day`, received at the clock's time. */
  const upload = async (
    device: ZkDeviceSimulator,
    day: IsoDate,
    punches: [string, string, boolean?][],
  ) => {
    const res = await device.uploadAttlog(
      punches.map(([pin, time, out]) => device.attlogLine(pin, dhaka(day, time), { out })),
    );
    expect(res.status).toBe(200);
  };

  /**
   * Wait until the devices worker has processed every punch of the institute and its job is gone
   * (while it exists, the receiver queues no other for the institute).
   */
  const settled = (tenantId: string) =>
    vi.waitFor(
      async () => {
        const left = await inTenant(tenantId, (tx) =>
          tx.devicePunch.count({ where: { processedAt: null } }),
        );
        if (left > 0) throw new Error('punches not processed yet');
        if (await ingest().queue.getJob(processPunchesJobId(tenantId))) {
          throw new Error('job not finished yet');
        }
      },
      { timeout: 10_000, interval: 100 },
    );

  /** PUT /attendance/settings with these changes. */
  const putSettings = async (token: string, change: Partial<AttendanceSettings>) => {
    const current = (await http(h()).get('/attendance/settings').set(bearer(token)).expect(200))
      .body as object;
    await http(h())
      .put('/attendance/settings')
      .set(bearer(token))
      .send({ ...current, ...change })
      .expect(200);
  };

  /** Take the institute's waiting process-punches job away (it waits a second) before it runs. */
  const holdJob = async (tenantId: string) => {
    expect(await ingest().queue.remove(processPunchesJobId(tenantId))).toBe(1);
  };

  const map = async (
    tenantId: string,
    rows: { deviceUserId: string; studentId?: string; staffUserId?: string }[],
  ): Promise<void> => {
    await inTenant(tenantId, (tx) =>
      tx.devicePerson.createMany({ data: rows.map((r) => ({ tenantId, ...r })) }),
    );
  };

  /** A staff member (with a staff profile); `tracked` sets their attendance switch. */
  const staff = async (tenantId: string, roles: Role[], tracked: boolean | null = null) => {
    const { userId } = await addMember(h(), tenantId, { roles });
    if (tracked !== null) {
      await inTenant(tenantId, (tx) =>
        tx.staffProfile.update({
          where: { tenantId_userId: { tenantId, userId } },
          data: { attendanceTracked: tracked },
        }),
      );
    }
    return userId;
  };

  const punches = (tenantId: string) =>
    inTenant(tenantId, (tx) =>
      tx.devicePunch.findMany({
        orderBy: [{ punchedAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          deviceUserId: true,
          punchedAt: true,
          localDate: true,
          direction: true,
          flags: true,
          review: true,
          outcome: true,
          processedAt: true,
        },
      }),
    );
  const punchOf = async (tenantId: string, deviceUserId: string, at: Date) => {
    const found = (await punches(tenantId)).find(
      (p) => p.deviceUserId === deviceUserId && p.punchedAt.getTime() === at.getTime(),
    );
    if (!found) throw new Error(`no punch of ${deviceUserId} at ${at.toISOString()}`);
    return found;
  };

  const smsLogs = (tenantId: string) =>
    inTenant(tenantId, (tx) =>
      tx.smsLog.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    );

  /** A DEVICE register for section A on `day`, as the cutoff writes it (statuses by roll). */
  const deviceRegister = (
    s: School,
    day: IsoDate,
    records: { status: AttendanceStatus; source?: 'DEVICE' | 'MANUAL' }[],
  ) =>
    inTenant(s.tenantId, async (tx) => {
      const session = await tx.attendanceSession.create({
        data: {
          tenantId: s.tenantId,
          sectionId: s.sectionA,
          date: dateToDb(day),
          periodNo: 0,
          source: 'DEVICE',
          submittedAt: dhaka(day, '09:00:00'),
          lastSubmissionId: randomUUID(),
        },
        select: { id: true },
      });
      await tx.attendanceRecord.createMany({
        data: s.a.map((st, i) => ({
          tenantId: s.tenantId,
          sessionId: session.id,
          studentId: st.id,
          status: records[i]!.status,
          source: records[i]!.source ?? 'DEVICE',
        })),
      });
      return session.id;
    });
  const register = (tenantId: string, sessionId: string) =>
    inTenant(tenantId, (tx) =>
      tx.attendanceSession.findUniqueOrThrow({
        where: { id: sessionId },
        select: {
          version: true,
          source: true,
          updatedById: true,
          submittedAt: true,
          records: { select: { studentId: true, status: true, source: true } },
        },
      }),
    );
  const statusOf = async (tenantId: string, sessionId: string, studentId: string) =>
    (await register(tenantId, sessionId)).records.find((r) => r.studentId === studentId)!.status;

  const audits = (tenantId: string, entity: string, entityId: string) =>
    inTenant(tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { entity, entityId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { action: true, actorUserId: true, oldValues: true, newValues: true },
      }),
    );

  const staffDays = (tenantId: string) =>
    inTenant(tenantId, (tx) =>
      tx.staffAttendanceDay.findMany({ orderBy: [{ userId: 'asc' }, { date: 'asc' }] }),
    );

  const review = (token: string, punchId: string, action: 'OK' | 'ACCEPT' | 'REJECT') =>
    http(h())
      .post(`/attendance/devices/punches/${punchId}/review`)
      .set(bearer(token))
      .send({ action });

  return {
    inTenant,
    addDevice,
    institute,
    sim,
    upload,
    settled,
    putSettings,
    holdJob,
    map,
    staff,
    punches,
    punchOf,
    smsLogs,
    deviceRegister,
    register,
    statusOf,
    audits,
    staffDays,
    review,
  };
}

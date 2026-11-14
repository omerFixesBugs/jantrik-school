import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, ingestClient, ownerClient, randomPhone } from './helpers.js';

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

const DAY = 86_400_000;

/** A serial number no earlier run has used: serials are unique across institutes. */
const newSerial = () => `T${randomUUID().replace(/-/g, '').slice(0, 15).toUpperCase()}`;

let pins = 0;
/** A punch `daysOld` days ago by a device user no other punch of this run has. */
function punchData(tenantId: string, deviceId: string, daysOld: number) {
  const at = new Date(Date.now() - daysOld * DAY);
  at.setUTCMilliseconds(0);
  return {
    tenantId,
    deviceId,
    deviceUserId: `P${++pins}`,
    deviceTime: at,
    punchedAt: at,
    receivedAt: at,
    localDate: new Date(at.toISOString().slice(0, 10)),
    direction: 'IN' as const,
  };
}

/**
 * An institute with a student, a staff member, a device, the student's device ID, a command, a
 * 40-day-old punch and a source address. Punches and addresses are written by the receiver (the
 * app has no INSERT on them), so they go in through the owner role, inside the tenant context.
 */
async function institute(app: PrismaClient, owner: PrismaClient) {
  const tenantId = (await createTenant(app)).id;
  const rows = await withTenant(app, tenantId, async (tx) => {
    const student = await tx.student.create({
      data: { tenantId, studentCode: `S-${randomUUID().slice(0, 8)}`, nameEn: 'Student' },
    });
    const staffUserId = await findOrCreateUser(tx, randomPhone(), 'Staff');
    await tx.membership.create({ data: { tenantId, userId: staffUserId, role: 'TEACHER' } });
    await tx.staffProfile.create({
      data: { tenantId, userId: staffUserId, name: 'Staff', phone: randomPhone() },
    });
    const device = await tx.attendanceDevice.create({
      data: { tenantId, serialNo: newSerial(), name: 'Main gate', direction: 'BOTH' },
    });
    const person = await tx.devicePerson.create({
      data: { tenantId, deviceUserId: '101', studentId: student.id },
    });
    const command = await tx.deviceCommand.create({
      data: {
        tenantId,
        deviceId: device.id,
        kind: 'USER_UPSERT',
        deviceUserId: '101',
        payload: 'DATA UPDATE USERINFO PIN=101\tName=Student',
      },
    });
    return { student, staffUserId, device, person, command };
  });
  const received = await withTenant(owner, tenantId, async (tx) => ({
    punch: await tx.devicePunch.create({ data: punchData(tenantId, rows.device.id, 40) }),
    sourceIp: await tx.deviceSourceIp.create({
      data: {
        tenantId,
        deviceId: rows.device.id,
        ip: '103.4.5.6',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        trustedAt: new Date(),
      },
    }),
  }));
  return {
    tenantId,
    studentId: rows.student.id,
    staffUserId: rows.staffUserId,
    deviceId: rows.device.id,
    serialNo: rows.device.serialNo,
    personId: rows.person.id,
    commandId: rows.command.id,
    punchId: received.punch.id,
    sourceIpId: received.sourceIp.id,
  };
}

const MODELS = [
  'attendanceDevice',
  'devicePerson',
  'deviceCommand',
  'devicePunch',
  'deviceSourceIp',
] as const;

const TABLE_NAMES = [
  'attendance_devices',
  'device_people',
  'device_commands',
  'device_punches',
  'device_source_ips',
];

describe('device tables: tenant isolation', () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  let a: Awaited<ReturnType<typeof institute>>;
  let b: Awaited<ReturnType<typeof institute>>;

  beforeAll(async () => {
    app = appClient();
    owner = ownerClient();
    a = await institute(app, owner);
    b = await institute(app, owner);
  });

  afterAll(async () => {
    await app.$disconnect();
    await owner.$disconnect();
  });

  it.each(MODELS)('%s: each tenant sees only its own rows', async (model) => {
    const rows = (tenantId: string) =>
      withTenant(app, tenantId, (tx) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx[model] as any).findMany({ select: { tenantId: true } }),
      ) as Promise<{ tenantId: string }[]>;
    const rowsA = await rows(a.tenantId);
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsA.every((r) => r.tenantId === a.tenantId)).toBe(true);
    const rowsB = await rows(b.tenantId);
    expect(rowsB.every((r) => r.tenantId === b.tenantId)).toBe(true);
  });

  it.each(MODELS)('%s: no context sees no rows', async (model) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (app[model] as any).count()).toBe(0);
  });

  it("another tenant cannot change or delete A's rows", async () => {
    const asB = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, b.tenantId, fn);
    const changed = [
      await asB((tx) =>
        tx.attendanceDevice.updateMany({ where: { id: a.deviceId }, data: { name: 'x' } }),
      ),
      await asB((tx) =>
        tx.devicePerson.updateMany({ where: { id: a.personId }, data: { deviceUserId: '999' } }),
      ),
      await asB((tx) =>
        tx.deviceCommand.updateMany({ where: { id: a.commandId }, data: { status: 'CANCELLED' } }),
      ),
      await asB((tx) =>
        tx.devicePunch.updateMany({
          where: { id: a.punchId },
          data: { review: 'REJECTED', reviewedAt: new Date() },
        }),
      ),
      await asB((tx) =>
        tx.deviceSourceIp.updateMany({
          where: { id: a.sourceIpId },
          data: { trustedAt: null },
        }),
      ),
      await asB((tx) => tx.devicePerson.deleteMany({ where: { id: a.personId } })),
      await asB((tx) => tx.deviceCommand.deleteMany({ where: { id: a.commandId } })),
      // 40 days old, so A itself could delete it: only RLS stops B.
      await asB((tx) => tx.devicePunch.deleteMany({ where: { id: a.punchId } })),
    ];
    expect(changed.map((r) => r.count)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    const punch = await withTenant(app, a.tenantId, (tx) =>
      tx.devicePunch.findUniqueOrThrow({ where: { id: a.punchId } }),
    );
    expect(punch.review).toBeNull();
  });

  it("another tenant cannot write a row with A's tenant_id", async () => {
    const asB = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, b.tenantId, fn);
    await expect(
      asB((tx) =>
        tx.attendanceDevice.create({
          data: { tenantId: a.tenantId, serialNo: newSerial(), name: 'x', direction: 'IN' },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      asB((tx) =>
        tx.devicePerson.create({
          data: { tenantId: a.tenantId, deviceUserId: '555', studentId: a.studentId },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      asB((tx) =>
        tx.deviceCommand.create({
          data: {
            tenantId: a.tenantId,
            deviceId: a.deviceId,
            kind: 'USER_DELETE',
            deviceUserId: '101',
            payload: 'DATA DELETE USERINFO PIN=101',
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
    // The receiver's tables, through a role that may insert into them.
    await expect(
      withTenant(owner, b.tenantId, (tx) =>
        tx.devicePunch.create({ data: punchData(a.tenantId, a.deviceId, 1) }),
      ),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      withTenant(owner, b.tenantId, (tx) =>
        tx.deviceSourceIp.create({
          data: {
            tenantId: a.tenantId,
            deviceId: a.deviceId,
            ip: '10.0.0.1',
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("tenant_id cannot be changed to another tenant's", async () => {
    for (const table of TABLE_NAMES) {
      await expect(
        withTenant(app, a.tenantId, (tx) =>
          tx.$executeRawUnsafe(`UPDATE ${table} SET tenant_id = '${b.tenantId}'`),
        ),
      ).rejects.toThrow(/row-level security|permission denied|foreign key/i);
    }
  });

  it("rows cannot point at another tenant's device, student or staff member", async () => {
    await expect(
      withTenant(app, b.tenantId, (tx) =>
        tx.devicePerson.create({
          data: { tenantId: b.tenantId, deviceUserId: '201', studentId: a.studentId },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withTenant(app, b.tenantId, (tx) =>
        tx.devicePerson.create({
          data: { tenantId: b.tenantId, deviceUserId: '202', staffUserId: a.staffUserId },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withTenant(app, b.tenantId, (tx) =>
        tx.deviceCommand.create({
          data: {
            tenantId: b.tenantId,
            deviceId: a.deviceId,
            kind: 'USER_DELETE',
            deviceUserId: '101',
            payload: 'DATA DELETE USERINFO PIN=101',
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withTenant(owner, b.tenantId, (tx) =>
        tx.devicePunch.create({ data: punchData(b.tenantId, a.deviceId, 1) }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withTenant(owner, b.tenantId, (tx) =>
        tx.deviceSourceIp.create({
          data: {
            tenantId: b.tenantId,
            deviceId: a.deviceId,
            ip: '10.0.0.2',
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('a serial number is active in one institute at most; inactive copies are allowed', async () => {
    const serialNo = newSerial();
    const add = (tenantId: string, isActive = true) =>
      withTenant(app, tenantId, (tx) =>
        tx.attendanceDevice.create({
          data: { tenantId, serialNo, name: 'Gate', direction: 'IN', isActive },
        }),
      );
    const deviceA = await add(a.tenantId);
    await expect(add(b.tenantId)).rejects.toThrow(/unique/i);
    await add(b.tenantId, false);
    await add(a.tenantId, false);
    await withTenant(app, a.tenantId, (tx) =>
      tx.attendanceDevice.update({ where: { id: deviceA.id }, data: { isActive: false } }),
    );
    const deviceB = await add(b.tenantId);
    expect(deviceB.isActive).toBe(true);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.attendanceDevice.update({ where: { id: deviceA.id }, data: { isActive: true } }),
      ),
    ).rejects.toThrow(/unique/i);
  });

  it('one device ID belongs to one person of an institute, student or staff', async () => {
    const map = (data: { deviceUserId: string; studentId?: string; staffUserId?: string }) =>
      withTenant(app, a.tenantId, (tx) =>
        tx.devicePerson.create({ data: { tenantId: a.tenantId, ...data } }),
      );
    // 101 is A's student's: refused for a staff member and for another student.
    await expect(map({ deviceUserId: '101', staffUserId: a.staffUserId })).rejects.toThrow(
      /unique/i,
    );
    const other = await withTenant(app, a.tenantId, (tx) =>
      tx.student.create({
        data: { tenantId: a.tenantId, studentCode: `S-${randomUUID().slice(0, 8)}`, nameEn: 'S2' },
      }),
    );
    await expect(map({ deviceUserId: '101', studentId: other.id })).rejects.toThrow(/unique/i);
    // One ID per person.
    await expect(map({ deviceUserId: '102', studentId: a.studentId })).rejects.toThrow(/unique/i);
    await map({ deviceUserId: '9001', staffUserId: a.staffUserId });
    await expect(map({ deviceUserId: '9002', staffUserId: a.staffUserId })).rejects.toThrow(
      /unique/i,
    );
    // B's student has 101 too: IDs are per institute.
    const personB = await withTenant(app, b.tenantId, (tx) =>
      tx.devicePerson.findUniqueOrThrow({ where: { id: b.personId } }),
    );
    expect(personB.deviceUserId).toBe('101');
  });

  it('checks reject bad values', async () => {
    const asA = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, a.tenantId, fn);
    for (const serialNo of ['abc12345', 'AB12', 'AB-12345']) {
      await expect(
        asA((tx) =>
          tx.attendanceDevice.create({
            data: { tenantId: a.tenantId, serialNo, name: 'Gate', direction: 'IN' },
          }),
        ),
      ).rejects.toThrow(/attendance_devices_serial_format/);
    }
    await expect(
      asA((tx) =>
        tx.attendanceDevice.create({
          data: { tenantId: a.tenantId, serialNo: newSerial(), name: '  ', direction: 'IN' },
        }),
      ),
    ).rejects.toThrow(/attendance_devices_name_length/);
    for (const deviceUserId of ['099', '12', '1234567890', '1a2']) {
      await expect(
        asA((tx) =>
          tx.devicePerson.create({
            data: { tenantId: a.tenantId, deviceUserId, staffUserId: a.staffUserId },
          }),
        ),
      ).rejects.toThrow(/device_people_device_user_id_format/);
    }
    await expect(
      asA((tx) =>
        tx.devicePerson.create({
          data: {
            tenantId: a.tenantId,
            deviceUserId: '777',
            studentId: a.studentId,
            staffUserId: a.staffUserId,
          },
        }),
      ),
    ).rejects.toThrow(/device_people_one_person/);
    await expect(
      asA((tx) => tx.devicePerson.create({ data: { tenantId: a.tenantId, deviceUserId: '778' } })),
    ).rejects.toThrow(/device_people_one_person/);
    const command = (payload: string, deviceUserId = '101') =>
      asA((tx) =>
        tx.deviceCommand.create({
          data: {
            tenantId: a.tenantId,
            deviceId: a.deviceId,
            kind: 'USER_UPSERT',
            deviceUserId,
            payload,
          },
        }),
      );
    for (const payload of [
      'DATA UPDATE USERINFO PIN=101\nC:9:DATA DELETE USERINFO PIN=1',
      'x\r',
      'নাম',
      '',
    ]) {
      await expect(command(payload)).rejects.toThrow(/device_commands_payload_format/);
    }
    await expect(command('DATA DELETE USERINFO PIN=012', '012')).rejects.toThrow(
      /device_commands_device_user_id_format/,
    );
    await expect(
      withTenant(owner, a.tenantId, (tx) =>
        tx.devicePunch.create({
          data: { ...punchData(a.tenantId, a.deviceId, 1), flags: ['NEW_IP', 'SPOOFED'] },
        }),
      ),
    ).rejects.toThrow(/device_punches_flags_known/);
    await expect(
      asA((tx) => tx.devicePunch.update({ where: { id: a.punchId }, data: { review: 'OK' } })),
    ).rejects.toThrow(/device_punches_reviewed_together/);
    await expect(
      asA((tx) =>
        tx.devicePunch.update({
          where: { id: a.punchId },
          data: { reviewedById: a.staffUserId },
        }),
      ),
    ).rejects.toThrow(/device_punches_reviewer_needs_review/);
    await expect(
      asA((tx) =>
        tx.devicePunch.update({ where: { id: a.punchId }, data: { processedAt: new Date() } }),
      ),
    ).rejects.toThrow(/device_punches_processed_together/);
    await expect(
      asA((tx) =>
        tx.deviceSourceIp.update({
          where: { id: a.sourceIpId },
          data: { trustedAt: null, trustedById: a.staffUserId },
        }),
      ),
    ).rejects.toThrow(/device_source_ips_trusted_by_needs_trusted_at/);
  });

  it('the app changes only the columns its screens change', async () => {
    const asA = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, a.tenantId, fn);
    const denied = [
      () =>
        asA((tx) =>
          tx.attendanceDevice.update({
            where: { id: a.deviceId },
            data: { lastSeenAt: new Date() },
          }),
        ),
      () => asA((tx) => tx.attendanceDevice.deleteMany({ where: { id: a.deviceId } })),
      () =>
        asA((tx) => tx.deviceCommand.update({ where: { id: a.commandId }, data: { attempts: 1 } })),
      () =>
        asA((tx) =>
          tx.deviceSourceIp.update({ where: { id: a.sourceIpId }, data: { punchCount: 9 } }),
        ),
      () => asA((tx) => tx.deviceSourceIp.deleteMany({ where: { id: a.sourceIpId } })),
      () =>
        asA((tx) =>
          tx.deviceSourceIp.createMany({
            data: [
              {
                tenantId: a.tenantId,
                deviceId: a.deviceId,
                ip: '10.0.0.3',
                firstSeenAt: new Date(),
                lastSeenAt: new Date(),
              },
            ],
          }),
        ),
    ];
    for (const run of denied) await expect(run()).rejects.toThrow(/permission denied/i);
    // What the screens do: rename and deactivate, cancel a command, trust an address.
    await asA((tx) =>
      tx.attendanceDevice.update({ where: { id: a.deviceId }, data: { name: 'Main gate 2' } }),
    );
    await asA((tx) =>
      tx.deviceCommand.update({ where: { id: a.commandId }, data: { status: 'CANCELLED' } }),
    );
    await asA((tx) =>
      tx.deviceSourceIp.update({
        where: { id: a.sourceIpId },
        data: { trustedAt: new Date(), trustedById: a.staffUserId },
      }),
    );
  });
});

describe('device_punches: immutable, deleted only after 30 days', () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  let a: Awaited<ReturnType<typeof institute>>;

  beforeAll(async () => {
    app = appClient();
    owner = ownerClient();
    a = await institute(app, owner);
  });

  afterAll(async () => {
    await app.$disconnect();
    await owner.$disconnect();
  });

  const storePunch = (daysOld: number) =>
    withTenant(owner, a.tenantId, (tx) =>
      tx.devicePunch.create({ data: punchData(a.tenantId, a.deviceId, daysOld) }),
    );

  it('the app cannot insert a punch', async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.devicePunch.createMany({ data: [punchData(a.tenantId, a.deviceId, 0)] }),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the app cannot change what the device sent, only processing and review', async () => {
    const { id } = await storePunch(1);
    for (const data of [
      { punchedAt: new Date() },
      { deviceTime: new Date() },
      { deviceUserId: 'P0' },
      { flags: [] },
    ]) {
      await expect(
        withTenant(app, a.tenantId, (tx) => tx.devicePunch.update({ where: { id }, data })),
      ).rejects.toThrow(/permission denied/i);
    }
    const reviewed = await withTenant(app, a.tenantId, (tx) =>
      tx.devicePunch.update({
        where: { id },
        data: {
          processedAt: new Date(),
          outcome: 'APPLIED',
          review: 'REJECTED',
          reviewedAt: new Date(),
          reviewedById: a.staffUserId,
        },
      }),
    );
    expect(reviewed).toMatchObject({ outcome: 'APPLIED', review: 'REJECTED' });
  });

  it('the app cannot delete a punch from the last 30 days', async () => {
    const { id } = await storePunch(10);
    const deleted = await withTenant(app, a.tenantId, (tx) =>
      tx.devicePunch.deleteMany({ where: { id } }),
    );
    expect(deleted.count).toBe(0);
    expect(await withTenant(app, a.tenantId, (tx) => tx.devicePunch.count({ where: { id } }))).toBe(
      1,
    );
  });

  it('the app can delete a punch older than 30 days', async () => {
    const { id } = await storePunch(40);
    const deleted = await withTenant(app, a.tenantId, (tx) =>
      tx.devicePunch.deleteMany({ where: { id } }),
    );
    expect(deleted.count).toBe(1);
  });
});

describe('attendance_settings: device and staff columns', () => {
  let app: PrismaClient;
  let tenantId: string;

  beforeAll(async () => {
    app = appClient();
    tenantId = (await createTenant(app)).id;
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  const time = (d: Date) => d.toISOString().slice(11, 16);

  it('a provisioned institute gets the defaults', async () => {
    const s = await withTenant(app, tenantId, (tx) =>
      tx.attendanceSettings.findUniqueOrThrow({ where: { tenantId } }),
    );
    expect(s).toMatchObject({
      deviceAutoMark: false,
      deviceGraceMinutes: 10,
      deviceCutoffMinutes: 60,
      entrySmsEnabled: false,
      exitSmsEnabled: false,
      staffLateGraceMinutes: 10,
      staffEarlyGraceMinutes: 10,
      deviceMaxPunchesPerMinute: 60,
      staffDeviceIdStart: 9001,
      punchRetentionDays: 730,
    });
    expect(
      [
        s.deviceDefaultStart,
        s.staffOfficeStart,
        s.staffOfficeEnd,
        s.deviceHoursStart,
        s.deviceHoursEnd,
      ].map(time),
    ).toEqual(['08:00', '08:00', '16:00', '05:00', '20:00']);
  });

  it('checks reject bad values', async () => {
    const update = (data: Record<string, unknown>) =>
      withTenant(app, tenantId, (tx) =>
        tx.attendanceSettings.update({ where: { tenantId }, data }),
      );
    const at = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
    await expect(update({ staffOfficeEnd: at('07:00') })).rejects.toThrow(
      /attendance_settings_staff_office_order/,
    );
    await expect(update({ deviceHoursEnd: at('05:00') })).rejects.toThrow(
      /attendance_settings_device_hours_order/,
    );
    await expect(update({ punchRetentionDays: 29 })).rejects.toThrow(
      /attendance_settings_punch_retention_range/,
    );
    await expect(update({ deviceMaxPunchesPerMinute: 9 })).rejects.toThrow(
      /attendance_settings_device_max_punches_range/,
    );
    await expect(update({ staffDeviceIdStart: 99 })).rejects.toThrow(
      /attendance_settings_staff_device_id_start_range/,
    );
    await expect(update({ deviceCutoffMinutes: 14 })).rejects.toThrow(
      /attendance_settings_device_cutoff_range/,
    );
    // The three grace minutes: 0 to 120.
    for (const [column, constraint] of [
      ['deviceGraceMinutes', 'attendance_settings_device_grace_range'],
      ['staffLateGraceMinutes', 'attendance_settings_staff_late_grace_range'],
      ['staffEarlyGraceMinutes', 'attendance_settings_staff_early_grace_range'],
    ] as const) {
      for (const value of [-1, 121]) {
        await expect(update({ [column]: value }), `${column} ${value}`).rejects.toThrow(
          new RegExp(constraint),
        );
      }
      await update({ [column]: 0 });
      await update({ [column]: 120 });
    }
  });
});

describe('the device receiver roles', () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  let ingest: PrismaClient;
  let a: Awaited<ReturnType<typeof institute>>;
  let b: Awaited<ReturnType<typeof institute>>;

  beforeAll(async () => {
    app = appClient();
    owner = ownerClient();
    ingest = ingestClient();
    a = await institute(app, owner);
    b = await institute(app, owner);
  });

  afterAll(async () => {
    await Promise.all([app.$disconnect(), owner.$disconnect(), ingest.$disconnect()]);
  });

  /** As jantrik_ingest (the owner may SET ROLE to it), with no tenant context. */
  const asIngest = <T>(fn: (tx: Tx) => Promise<T>) =>
    owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE jantrik_ingest');
      return fn(tx);
    });

  it('jantrik_ingest_app cannot read any table', async () => {
    for (const table of ['attendance_devices', 'device_punches', 'students']) {
      await expect(ingest.$queryRawUnsafe(`SELECT * FROM ${table} LIMIT 1`)).rejects.toThrow(
        /permission denied/i,
      );
    }
  });

  it('jantrik_ingest_app cannot write any table either', async () => {
    for (const sql of [
      'INSERT INTO attendance_devices (id) VALUES (gen_random_uuid())',
      'INSERT INTO device_commands (id) VALUES (gen_random_uuid())',
      'INSERT INTO device_people (id) VALUES (gen_random_uuid())',
      'INSERT INTO device_punches (id) VALUES (gen_random_uuid())',
      'INSERT INTO device_source_ips (id) VALUES (gen_random_uuid())',
      'UPDATE device_commands SET attempts = attempts',
      'DELETE FROM device_commands',
      'DELETE FROM device_source_ips',
      'DELETE FROM device_punches',
    ]) {
      await expect(ingest.$executeRawUnsafe(sql), sql).rejects.toThrow(/permission denied/i);
    }
  });

  it('jantrik_ingest sees every institute without a context, but only the columns it needs', async () => {
    const ids = `('${a.deviceId}', '${b.deviceId}')`;
    const count = (sql: string) =>
      asIngest(async (tx) => (await tx.$queryRawUnsafe<{ n: bigint }[]>(sql))[0]?.n);
    expect(await count(`SELECT count(*) AS n FROM attendance_devices WHERE id IN ${ids}`)).toBe(2n);
    expect(await count(`SELECT count(*) AS n FROM device_punches WHERE device_id IN ${ids}`)).toBe(
      2n,
    );
    expect(
      await count(
        `SELECT count(*) AS n FROM tenants t
         JOIN attendance_settings s ON s.tenant_id = t.id
         JOIN tenant_modules m ON m.tenant_id = t.id AND m.module_key = 'ATTENDANCE'
         WHERE t.id IN ('${a.tenantId}', '${b.tenantId}') AND s.device_max_punches_per_minute = 60`,
      ),
    ).toBe(2n);
    for (const sql of [
      'SELECT name FROM tenants',
      'SELECT absent_sms_enabled FROM attendance_settings',
      'SELECT id, punched_at FROM device_punches',
      'SELECT device_user_id FROM device_people',
      'SELECT id FROM students',
      "UPDATE attendance_devices SET name = 'x'",
      "UPDATE device_punches SET outcome = 'APPLIED'",
      'DELETE FROM device_punches',
      'UPDATE device_commands SET payload = payload',
      'UPDATE device_source_ips SET trusted_at = now()',
      'INSERT INTO attendance_devices (id) VALUES (gen_random_uuid())',
      'INSERT INTO device_commands (id) VALUES (gen_random_uuid())',
      'INSERT INTO device_people (id) VALUES (gen_random_uuid())',
      'DELETE FROM device_commands',
    ]) {
      await expect(asIngest((tx) => tx.$executeRawUnsafe(sql))).rejects.toThrow(
        /permission denied/i,
      );
    }
  });

  it('jantrik_ingest can store punches and addresses and write the receiver columns', async () => {
    const counts = await asIngest(async (tx) => {
      const run = (sql: string) => tx.$executeRawUnsafe(sql, a.tenantId, a.deviceId);
      const insertPunch = () =>
        run(`INSERT INTO device_punches (id, tenant_id, device_id, device_user_id, device_time,
               punched_at, local_date, received_at, direction, flags)
             VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'P9000', '2026-10-20 08:00:00',
               now(), '2026-10-20', now(), 'IN', '{NEW_IP}')
             ON CONFLICT (tenant_id, device_id, device_user_id, device_time) DO NOTHING`);
      return [
        await insertPunch(),
        await insertPunch(), // the dedupe
        await run(`UPDATE attendance_devices SET last_seen_at = now(), clock_samples = '{60}'
                   WHERE tenant_id = $1::uuid AND id = $2::uuid`),
        await run(`INSERT INTO device_source_ips (id, tenant_id, device_id, ip, first_seen_at,
                     last_seen_at)
                   VALUES (gen_random_uuid(), $1::uuid, $2::uuid, '10.1.1.1', now(), now())`),
        await run(`UPDATE device_source_ips SET punch_count = punch_count + 1, last_seen_at = now()
                   WHERE tenant_id = $1::uuid AND device_id = $2::uuid`),
        await run(`UPDATE device_commands SET status = 'SENT', attempts = attempts + 1,
                     sent_at = now()
                   WHERE tenant_id = $1::uuid AND device_id = $2::uuid`),
      ];
    });
    expect(counts).toEqual([1, 0, 1, 1, 2, 1]);
  });

  it('jantrik_ingest may delete only untrusted addresses (to make room for new ones)', async () => {
    const untrusted = await withTenant(owner, a.tenantId, (tx) =>
      tx.deviceSourceIp.create({
        data: {
          tenantId: a.tenantId,
          deviceId: a.deviceId,
          ip: '10.2.2.2',
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
      }),
    );
    const deleted = await asIngest(async (tx) => [
      await tx.$executeRawUnsafe(`DELETE FROM device_source_ips WHERE id = '${a.sourceIpId}'`),
      await tx.$executeRawUnsafe(`DELETE FROM device_source_ips WHERE id = '${untrusted.id}'`),
    ]);
    expect(deleted).toEqual([0, 1]);
  });

  it('an unknown or inactive serial number is looked up by an index, not a scan', async () => {
    // As the receiver's refusal asks it (jantrik_ingest, by serial number alone): the unique
    // index covers active devices only.
    const plan = await asIngest(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        "EXPLAIN SELECT 1 FROM attendance_devices WHERE serial_no = 'ABCDEF12'",
      );
    });
    expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain(
      'attendance_devices_serial_no_idx',
    );
  });

  it('jantrik_ingest cannot delete a trusted address even inside an institute context', async () => {
    // tenant_isolation (permissive, every role) would allow it there; the RESTRICTIVE
    // ingest_delete_untrusted_only does not.
    const deleted = await asIngest(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${a.tenantId}, true)`;
      return tx.$executeRawUnsafe(`DELETE FROM device_source_ips WHERE id = '${a.sourceIpId}'`);
    });
    expect(deleted).toBe(0);
    const kept = await withTenant(owner, a.tenantId, (tx) =>
      tx.deviceSourceIp.findUnique({ where: { id: a.sourceIpId } }),
    );
    expect(kept?.trustedAt).not.toBeNull();
  });

  it('the owner does not inherit what jantrik_ingest may see', async () => {
    expect(await owner.attendanceDevice.count()).toBe(0);
  });
});

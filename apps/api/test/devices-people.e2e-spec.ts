import { randomUUID } from 'node:crypto';
import { findOrCreateUser, withTenant, type TenantTx } from '@jantrik/db';
import { ZkDeviceSimulator } from '@jantrik/device-sim';
import {
  toCsv,
  type AttendanceSettings,
  type DeviceDefaultsResult,
  type DeviceIdCollisionView,
  type DeviceImportResult,
  type DevicePeopleList,
  type DevicePersonRef,
  type DeviceView,
  type RemoveFromDevicesResult,
  type SetDeviceIdResult,
  type StaleDevicePerson,
} from '@jantrik/shared';
import type request from 'supertest';
import { FakeClock } from './support/clock.js';
import {
  addMember,
  bearer,
  createHarness,
  createStudent,
  createTenant,
  http,
  otpLogin,
  randomIp,
  randomPhone,
  type Harness,
} from './support/harness.js';
import { createIngestHarness, type IngestHarness } from './support/ingest.js';
import { school, type School } from './support/school.js';

// People ↔ device IDs (OWNER/ADMIN). Commands are confirmed by a simulated device through the
// receiver, never by the app role. Both apps share one FakeClock.

const T0 = new Date('2026-10-21T08:00:00+06:00');
const newSerial = () => `P${randomUUID().replace(/-/g, '').slice(0, 15).toUpperCase()}`;
/** Four enrolled students (section A rolls 1–3, then section B), codes in this order. */
const CODES = ['SHS-2026-0001', 'SHS-2026-0002', 'SHS-2026-0003', 'SHS-2026-0004'];

interface Fixture extends School {
  /** a1, a2, a3, b1: ids. */
  students: string[];
  /** Admin, teacher, other teacher (profiles "Staff 1" to "Staff 3"), in the order added. */
  staff: { id: string; phone: string }[];
  classLevel: { id: string; nameBn: string; nameEn: string };
}

describe('device people API', () => {
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

  const inTenant = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) =>
    withTenant(h.prisma, tenantId, fn);
  const get = (token: string, path: string, query: Record<string, string> = {}) =>
    http(h).get(path).query(query).set(bearer(token));
  const post = (token: string, path: string, body: object = {}) =>
    http(h).post(path).set(bearer(token)).send(body);
  const put = (token: string, body: object) =>
    http(h).put('/attendance/device-people').set(bearer(token)).send(body);
  const setId = async (token: string, body: object) =>
    (await put(token, body).expect(200)).body as SetDeviceIdResult;
  const people = async (token: string, query: Record<string, string> = {}) =>
    (await get(token, '/attendance/device-people', query).expect(200)).body as DevicePeopleList;
  const defaults = async (token: string, kind: string, dryRun: boolean) =>
    (await post(token, '/attendance/device-people/defaults', { kind, dryRun }).expect(200))
      .body as DeviceDefaultsResult;
  const upload = (token: string, csv: string, apply: boolean, name = 'ids.csv') =>
    http(h)
      .post('/attendance/device-people/import')
      .query({ apply: apply ? '1' : '0' })
      .set(bearer(token))
      .attach('file', Buffer.from(csv), name);
  const imported = async (token: string, csv: string, apply: boolean) =>
    (await upload(token, csv, apply).expect(200)).body as DeviceImportResult;
  /** The raw body of a text download (BOM included). */
  const text = async (res: request.Test) =>
    (
      await res
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
        })
        .expect(200)
    ).body as string;

  const fixture = async (codes = CODES): Promise<Fixture> => {
    const s = await school(h, { settings: { absentSmsEnabled: false } });
    const students = [...s.a, ...s.b].map((x) => x.id);
    return inTenant(s.tenantId, async (tx) => {
      for (const [i, id] of students.entries()) {
        await tx.student.update({ where: { id }, data: { studentCode: codes[i]! } });
      }
      const profiles = await tx.staffProfile.findMany({
        orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
      });
      for (const [i, p] of profiles.entries()) {
        await tx.staffProfile.update({ where: { id: p.id }, data: { name: `Staff ${i + 1}` } });
      }
      const classLevel = await tx.classLevel.findFirstOrThrow({
        orderBy: { sortOrder: 'asc' },
        select: { id: true, nameBn: true, nameEn: true },
      });
      return {
        ...s,
        students,
        staff: profiles.map((p) => ({ id: p.userId, phone: p.phone })),
        classLevel,
      };
    });
  };
  /** One more student enrolled this year in section B. */
  const enrol = (f: Fixture, code: string, roll: number) =>
    inTenant(f.tenantId, async (tx) => {
      const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      const st = await tx.student.create({
        data: { tenantId: f.tenantId, studentCode: code, nameEn: code },
      });
      await tx.enrolment.create({
        data: {
          tenantId: f.tenantId,
          studentId: st.id,
          academicYearId: year.id,
          classLevelId: f.classLevel.id,
          sectionId: f.sectionB,
          roll,
        },
      });
      return st.id;
    });
  /** A row written directly, as an earlier mapping (no commands). */
  const map = (tenantId: string, row: { deviceUserId: string; studentId?: string }) =>
    inTenant(tenantId, (tx) => tx.devicePerson.create({ data: { tenantId, ...row } }));
  const mapped = (tenantId: string) =>
    inTenant(tenantId, async (tx) =>
      Object.fromEntries(
        (await tx.devicePerson.findMany()).map((r) => [
          r.studentId ?? r.staffUserId,
          r.deviceUserId,
        ]),
      ),
    );
  const addDevice = async (token: string, isActive = true) => {
    const device = (
      await post(token, '/attendance/devices', {
        serialNo: newSerial(),
        name: 'Gate',
        direction: 'IN',
      }).expect(201)
    ).body as DeviceView;
    if (!isActive) {
      await http(h)
        .patch(`/attendance/devices/${device.id}`)
        .set(bearer(token))
        .send({ isActive: false })
        .expect(200);
    }
    return device;
  };
  const sim = (device: DeviceView) =>
    new ZkDeviceSimulator({
      baseUrl: ingest.baseUrl,
      sn: device.serialNo,
      forwardedFor: randomIp(),
    });
  const commands = (tenantId: string, deviceId: string) =>
    inTenant(tenantId, (tx) =>
      tx.deviceCommand.findMany({
        where: { deviceId },
        orderBy: { seq: 'asc' },
        select: { kind: true, deviceUserId: true, payload: true, status: true },
      }),
    );
  const audits = (tenantId: string, entity: string) =>
    inTenant(tenantId, (tx) =>
      tx.auditLog.findMany({
        where: { entity },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { entityId: true, action: true, oldValues: true, newValues: true },
      }),
    );
  const putSettings = async (token: string, change: Partial<AttendanceSettings>) => {
    const current = (await get(token, '/attendance/settings').expect(200)).body as object;
    await http(h)
      .put('/attendance/settings')
      .set(bearer(token))
      .send({ ...current, ...change })
      .expect(200);
  };
  const studentRef = (f: Fixture, i: number, code = CODES[i]!): DevicePersonRef => ({
    kind: 'STUDENT',
    id: f.students[i]!,
    name: `Student ${[1, 2, 3, 1][i]}`,
    nameBn: `ছাত্র ${[1, 2, 3, 1][i]}`,
    studentCode: code,
  });
  const staffRef = (f: Fixture, i: number): DevicePersonRef => ({
    kind: 'STAFF',
    id: f.staff[i]!.id,
    name: `Staff ${i + 1}`,
    nameBn: null,
  });

  describe('access', () => {
    it('teachers, accountants and guardians get 403; so does an institute without attendance', async () => {
      const f = await fixture();
      for (const role of ['TEACHER', 'ACCOUNTANT', 'GUARDIAN'] as const) {
        const { phone } = await addMember(h, f.tenantId, { roles: [role] });
        const token = (await otpLogin(h, phone)).accessToken;
        await get(token, '/attendance/device-people').expect(403);
        await get(token, '/attendance/device-people/csv').expect(403);
        await put(token, { studentId: f.students[0], deviceUserId: '101' }).expect(403);
        await post(token, '/attendance/device-people/defaults', {
          kind: 'ALL',
          dryRun: true,
        }).expect(403);
      }
      const off = (await createTenant(h)).id;
      const { phone } = await addMember(h, off, { roles: ['ADMIN'] });
      const admin = (await otpLogin(h, phone)).accessToken;
      await get(admin, '/attendance/device-people').expect(403);
      await get(admin, '/attendance/device-people/stale').expect(403);
    });
  });

  describe('the list', () => {
    it("this year's active students by class, section and roll, then active staff in the order added", async () => {
      const f = await fixture();
      // Not listed: an inactive, a deleted and a not-enrolled student, staff without a profile,
      // an invited staff member and a disabled one.
      await inTenant(f.tenantId, async (tx) => {
        const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
        for (const [code, data] of [
          ['GONE-1', { status: 'INACTIVE' as const }],
          ['GONE-2', { deletedAt: new Date() }],
        ] as const) {
          const st = await tx.student.create({
            data: { tenantId: f.tenantId, studentCode: code, nameEn: code, ...data },
          });
          await tx.enrolment.create({
            data: {
              tenantId: f.tenantId,
              studentId: st.id,
              academicYearId: year.id,
              classLevelId: f.classLevel.id,
              sectionId: f.sectionB,
            },
          });
        }
        await tx.student.create({
          data: { tenantId: f.tenantId, studentCode: 'NOT-ENROLLED', nameEn: 'x' },
        });
      });
      await inTenant(f.tenantId, async (tx) => {
        const legacy = await findOrCreateUser(tx, randomPhone(), 'Legacy');
        await tx.membership.create({
          data: { tenantId: f.tenantId, userId: legacy, role: 'TEACHER' },
        });
      });
      const disabled = await addMember(h, f.tenantId, { roles: ['TEACHER'] });
      await inTenant(f.tenantId, (tx) =>
        tx.membership.updateMany({
          where: { userId: disabled.userId },
          data: { status: 'DISABLED' },
        }),
      );
      await post(f.admin, '/staff', {
        phone: randomPhone(),
        name: 'Invited',
        roles: ['TEACHER'],
      }).expect(201);
      await setId(f.admin, { studentId: f.students[1], deviceUserId: '101' });

      const list = await people(f.admin);
      expect(list.counts).toEqual({ students: 4, studentsUnmapped: 3, staff: 3, staffUnmapped: 3 });
      expect(list.people.map((p) => p.id)).toEqual([...f.students, ...f.staff.map((s) => s.id)]);
      expect(list.people[0]).toEqual({
        kind: 'STUDENT',
        id: f.students[0],
        nameBn: 'ছাত্র 1',
        nameEn: 'Student 1',
        studentCode: 'SHS-2026-0001',
        classLevel: f.classLevel,
        section: { id: f.sectionA, name: 'A' },
        deviceUserId: null,
        suggested: '20260001',
        sync: 'NONE',
      });
      expect(list.people[1]).toMatchObject({ deviceUserId: '101', suggested: null });
      expect(list.people[4]).toEqual({
        kind: 'STAFF',
        id: f.staff[0]!.id,
        name: 'Staff 1',
        nameBn: null,
        roles: ['ADMIN'],
        deviceUserId: null,
        suggested: '9001',
        sync: 'NONE',
      });
      expect(list.people.slice(4).map((p) => p.suggested)).toEqual(['9001', '9002', '9003']);

      const staffOnly = await people(f.admin, { kind: 'STAFF' });
      expect(staffOnly.people.map((p) => p.kind)).toEqual(['STAFF', 'STAFF', 'STAFF']);
      expect(staffOnly.counts).toEqual(list.counts);
      expect(
        (await people(f.admin, { kind: 'STUDENT', unmapped: '1' })).people.map((p) => p.id),
      ).toEqual([f.students[0], f.students[2], f.students[3]]);
      expect((await people(f.admin, { sectionId: f.sectionB })).people.map((p) => p.id)).toEqual([
        f.students[3],
      ]);
      await get(f.admin, '/attendance/device-people', { kind: 'GUARDIAN' }).expect(400);
    });

    it('sync: PENDING while waiting, DONE once every active device confirmed, NONE when one lacks it, FAILED', async () => {
      const f = await fixture();
      const d1 = await addDevice(f.admin);
      const r1 = sim(d1);
      await setId(f.admin, { studentId: f.students[0], deviceUserId: '101' });
      const syncOf = async () =>
        Object.fromEntries((await people(f.admin)).people.map((p) => [p.id, p.sync]));
      expect((await syncOf())[f.students[0]!]).toBe('PENDING');
      await r1.poll();
      expect((await syncOf())[f.students[0]!]).toBe('DONE');

      const d2 = await addDevice(f.admin);
      const r2 = sim(d2);
      expect((await syncOf())[f.students[0]!]).toBe('NONE');
      await setId(f.admin, { studentId: f.students[1], deviceUserId: '102' });
      await post(f.admin, `/attendance/devices/${d2.id}/sync`).expect(200);
      await r1.poll();
      await r2.poll();
      expect(await syncOf()).toMatchObject({ [f.students[0]!]: 'DONE', [f.students[1]!]: 'DONE' });

      // The latest add on one device failed.
      await setId(f.admin, { studentId: f.students[1], deviceUserId: '103' });
      await r1.poll();
      await inTenant(f.tenantId, (tx) =>
        tx.deviceCommand.updateMany({
          where: { deviceId: d2.id, deviceUserId: '103' },
          data: { status: 'FAILED' },
        }),
      );
      expect((await syncOf())[f.students[1]!]).toBe('FAILED');
      // A switched-off device does not count.
      await http(h)
        .patch(`/attendance/devices/${d2.id}`)
        .set(bearer(f.admin))
        .send({ isActive: false })
        .expect(200);
      expect((await syncOf())[f.students[1]!]).toBe('DONE');
    });
  });

  describe('setting one ID', () => {
    it('set, change and clear: audited; a change asks for re-enrolment; a clear queues nothing', async () => {
      const f = await fixture();
      const on = await addDevice(f.admin);
      const off = await addDevice(f.admin, false);
      const a1 = f.students[0]!;

      expect(await setId(f.admin, { studentId: a1, deviceUserId: ' ১০১ ' })).toEqual({
        deviceUserId: '101',
        previous: null,
        reenrol: false,
        queued: 1,
      });
      // The same ID again changes nothing.
      expect(await setId(f.admin, { studentId: a1, deviceUserId: '101' })).toEqual({
        deviceUserId: '101',
        previous: '101',
        reenrol: false,
        queued: 0,
      });
      expect(await setId(f.admin, { studentId: a1, deviceUserId: '102' })).toEqual({
        deviceUserId: '102',
        previous: '101',
        reenrol: true,
        queued: 1,
      });
      expect(await setId(f.admin, { studentId: a1, deviceUserId: null })).toEqual({
        deviceUserId: null,
        previous: '102',
        reenrol: false,
        queued: 0,
      });
      expect(await mapped(f.tenantId)).toEqual({});
      expect(await setId(f.admin, { staffUserId: f.staff[1]!.id, deviceUserId: '9001' })).toEqual({
        deviceUserId: '9001',
        previous: null,
        reenrol: false,
        queued: 1,
      });

      const rows = await audits(f.tenantId, 'device_person');
      expect(
        rows.map(({ action, oldValues, newValues }) => ({ action, oldValues, newValues })),
      ).toEqual([
        {
          action: 'CREATE',
          oldValues: null,
          newValues: { studentId: a1, deviceUserId: '101' },
        },
        {
          action: 'UPDATE',
          oldValues: { studentId: a1, deviceUserId: '101' },
          newValues: { studentId: a1, deviceUserId: '102' },
        },
        {
          action: 'DELETE',
          oldValues: { studentId: a1, deviceUserId: '102' },
          newValues: null,
        },
        {
          action: 'CREATE',
          oldValues: null,
          newValues: { staffUserId: f.staff[1]!.id, deviceUserId: '9001' },
        },
      ]);
      expect(rows[0]!.entityId).toBe(rows[2]!.entityId);

      expect(await commands(f.tenantId, on.id)).toEqual([
        {
          kind: 'USER_UPSERT',
          deviceUserId: '101',
          payload: 'DATA UPDATE USERINFO PIN=101\tName=Student 1',
          status: 'PENDING',
        },
        {
          kind: 'USER_UPSERT',
          deviceUserId: '102',
          payload: 'DATA UPDATE USERINFO PIN=102\tName=Student 1',
          status: 'PENDING',
        },
        {
          kind: 'USER_UPSERT',
          deviceUserId: '9001',
          payload: 'DATA UPDATE USERINFO PIN=9001\tName=Staff 2',
          status: 'PENDING',
        },
      ]);
      expect(await commands(f.tenantId, off.id)).toEqual([]);

      // Validation and unknown people.
      await put(f.admin, { deviceUserId: '105' }).expect(400);
      await put(f.admin, {
        studentId: a1,
        staffUserId: f.staff[1]!.id,
        deviceUserId: '105',
      }).expect(400);
      await put(f.admin, { studentId: a1, deviceUserId: '0105' }).expect(400);
      await put(f.admin, { studentId: randomUUID(), deviceUserId: '105' }).expect(404);
    });

    it('a student and a staff member cannot share an ID: 409 naming the holder, nothing changed', async () => {
      const f = await fixture();
      await setId(f.admin, { studentId: f.students[0], deviceUserId: '500' });
      const res = await put(f.admin, { staffUserId: f.staff[1]!.id, deviceUserId: '500' }).expect(
        409,
      );
      expect(res.body).toEqual({
        statusCode: 409,
        code: 'DEVICE_ID_TAKEN',
        message: 'Someone else here has this device ID',
        holder: studentRef(f, 0),
      });
      await setId(f.admin, { staffUserId: f.staff[1]!.id, deviceUserId: '600' });
      const back = await put(f.admin, { studentId: f.students[0], deviceUserId: '600' }).expect(
        409,
      );
      expect(back.body.holder).toEqual(staffRef(f, 1));
      expect(await mapped(f.tenantId)).toEqual({
        [f.students[0]!]: '500',
        [f.staff[1]!.id]: '600',
      });
      // Someone no longer active still holds theirs.
      await inTenant(f.tenantId, (tx) =>
        tx.student.update({ where: { id: f.students[0] }, data: { status: 'INACTIVE' } }),
      );
      await put(f.admin, { studentId: f.students[1], deviceUserId: '500' }).expect(409);
    });

    it('an invited or disabled staff member, a guardian or a stranger is NOT_STAFF', async () => {
      const f = await fixture();
      const invited = (
        await post(f.admin, '/staff', {
          phone: randomPhone(),
          name: 'Invited',
          roles: ['TEACHER'],
        }).expect(201)
      ).body as { userId: string };
      const disabled = await addMember(h, f.tenantId, { roles: ['TEACHER'] });
      await inTenant(f.tenantId, (tx) =>
        tx.membership.updateMany({
          where: { userId: disabled.userId },
          data: { status: 'DISABLED' },
        }),
      );
      const guardian = await addMember(h, f.tenantId, { roles: ['GUARDIAN'] });
      for (const userId of [invited.userId, disabled.userId, guardian.userId, randomUUID()]) {
        const res = await put(f.admin, { staffUserId: userId, deviceUserId: '700' }).expect(422);
        expect(res.body.code).toBe('NOT_STAFF');
      }
      expect(await mapped(f.tenantId)).toEqual({});
    });
  });

  describe('default IDs', () => {
    it('students get the digits of their code; shared, taken or unusable defaults are reported, not assigned; a dry run writes nothing', async () => {
      const f = await fixture(['SHS-2026-0042', 'ALO-26-001', 'ALO-260-01', 'SHS-2026-0099']);
      const device = await addDevice(f.admin);
      const noDigits = await enrol(f, 'NO-CODE', 2);
      // 20260099 is held by a student who left.
      const gone = await createStudent(h, f.tenantId, 'GONE-0099');
      await inTenant(f.tenantId, (tx) =>
        tx.student.update({ where: { id: gone.id }, data: { status: 'INACTIVE' } }),
      );
      await map(f.tenantId, { deviceUserId: '20260099', studentId: gone.id });

      const expected: Omit<DeviceDefaultsResult, 'queued'> = {
        assigned: [{ person: studentRef(f, 0, 'SHS-2026-0042'), deviceUserId: '20260042' }],
        conflicts: [
          {
            person: studentRef(f, 1, 'ALO-26-001'),
            deviceUserId: '26001',
            reason: 'SHARED',
            heldBy: null,
          },
          {
            person: studentRef(f, 2, 'ALO-260-01'),
            deviceUserId: '26001',
            reason: 'SHARED',
            heldBy: null,
          },
          {
            person: studentRef(f, 3, 'SHS-2026-0099'),
            deviceUserId: '20260099',
            reason: 'TAKEN',
            heldBy: {
              kind: 'STUDENT',
              id: gone.id,
              name: 'GONE-0099',
              nameBn: null,
              studentCode: 'GONE-0099',
            },
          },
          {
            person: {
              kind: 'STUDENT',
              id: noDigits,
              name: 'NO-CODE',
              nameBn: null,
              studentCode: 'NO-CODE',
            },
            deviceUserId: null,
            reason: 'NO_DEFAULT',
            heldBy: null,
          },
        ],
      };
      expect(await defaults(f.admin, 'STUDENT', true)).toEqual({ ...expected, queued: 0 });
      expect(await mapped(f.tenantId)).toEqual({ [gone.id]: '20260099' });
      expect(await commands(f.tenantId, device.id)).toEqual([]);
      expect(await audits(f.tenantId, 'device_people_batch')).toEqual([]);

      expect(await defaults(f.admin, 'STUDENT', false)).toEqual({ ...expected, queued: 1 });
      expect(await mapped(f.tenantId)).toEqual({
        [gone.id]: '20260099',
        [f.students[0]!]: '20260042',
      });
      expect(await commands(f.tenantId, device.id)).toEqual([
        {
          kind: 'USER_UPSERT',
          deviceUserId: '20260042',
          payload: 'DATA UPDATE USERINFO PIN=20260042\tName=Student 1',
          status: 'PENDING',
        },
      ]);
      expect((await audits(f.tenantId, 'device_people_batch')).map((a) => a.newValues)).toEqual([
        {
          source: 'DEFAULTS',
          changes: [{ studentId: f.students[0], from: null, to: '20260042' }],
        },
      ]);
      // Staff were not part of it.
      expect((await people(f.admin, { kind: 'STAFF' })).counts.staffUnmapped).toBe(3);
      expect((await defaults(f.admin, 'STUDENT', false)).assigned).toEqual([]);
    });

    it('staff from the staff start in the order added, skipping used numbers and every student code number; a changed start is honoured', async () => {
      // a1 (unmapped) wants 9002; a2 is mapped elsewhere but its code still reserves 9004.
      const f = await fixture(['S-9002', 'S-9004', 'S-0003', 'S-0004']);
      const device = await addDevice(f.admin);
      await setId(f.admin, { studentId: f.students[1], deviceUserId: '777' });
      await setId(f.admin, { studentId: f.students[2], deviceUserId: '9003' });
      await setId(f.admin, { staffUserId: f.staff[1]!.id, deviceUserId: '9001' });
      const fourth = await addMember(h, f.tenantId, { roles: ['STAFF'], name: 'Staff 4' });

      const dry = await defaults(f.admin, 'STAFF', true);
      expect(dry.assigned.map((a) => [a.person.id, a.deviceUserId])).toEqual([
        [f.staff[0]!.id, '9005'],
        [f.staff[2]!.id, '9006'],
        [fourth.userId, '9007'],
      ]);
      expect(dry.conflicts).toEqual([]);
      // The screen suggests the same numbers.
      const listed = (await people(f.admin, { kind: 'STAFF', unmapped: '1' })).people;
      expect(listed.map((p) => [p.id, p.suggested])).toEqual(
        dry.assigned.map((a) => [a.person.id, a.deviceUserId]),
      );

      await putSettings(f.admin, { staffDeviceIdStart: 500 });
      expect((await defaults(f.admin, 'STAFF', true)).assigned.map((a) => a.deviceUserId)).toEqual([
        '500',
        '501',
        '502',
      ]);
      const before = (await commands(f.tenantId, device.id)).length;
      const applied = await defaults(f.admin, 'ALL', false);
      // ALL: a1's code number too (students first).
      expect(applied.assigned.map((a) => a.deviceUserId)).toEqual(['9002', '500', '501', '502']);
      expect(applied.queued).toBe(4);
      expect((await commands(f.tenantId, device.id)).length).toBe(before + 4);
      expect(await mapped(f.tenantId)).toMatchObject({
        [f.students[0]!]: '9002',
        [f.staff[0]!.id]: '500',
        [f.staff[2]!.id]: '501',
        [fourth.userId]: '502',
      });
    });
  });

  it('collisions: a default someone else holds, and a number two unmapped students want', async () => {
    const f = await fixture(['SHS-2026-0042', 'A-26001', 'B-26001', 'SHS-2026-0044']);
    await setId(f.admin, { staffUserId: f.staff[1]!.id, deviceUserId: '20260042' });
    await setId(f.admin, { studentId: f.students[3], deviceUserId: '20260044' });
    expect((await get(f.admin, '/attendance/device-people/collisions').expect(200)).body).toEqual([
      {
        deviceUserId: '20260042',
        wantedBy: [studentRef(f, 0, 'SHS-2026-0042')],
        heldBy: staffRef(f, 1),
      },
      {
        deviceUserId: '26001',
        wantedBy: [studentRef(f, 1, 'A-26001'), studentRef(f, 2, 'B-26001')],
        heldBy: null,
      },
    ] satisfies DeviceIdCollisionView[]);
  });

  describe('CSV', () => {
    it('export: BOM, CRLF, the English header in both languages, ASCII IDs, current or suggested', async () => {
      const f = await fixture();
      await setId(f.admin, { studentId: f.students[0], deviceUserId: '১০১' });
      await setId(f.admin, { staffUserId: f.staff[0]!.id, deviceUserId: '9500' });
      await inTenant(f.tenantId, (tx) =>
        tx.staffProfile.updateMany({
          where: { userId: f.staff[1]!.id },
          data: { nameBn: 'কর্মী দুই' },
        }),
      );
      const res = http(h)
        .get('/attendance/device-people/csv')
        .query({ locale: 'bn' })
        .set(bearer(f.admin));
      const bn = await text(res);
      expect(bn.charCodeAt(0)).toBe(0xfeff);
      expect(bn.endsWith('\r\n')).toBe(true);
      const lines = bn.slice(1).split('\r\n').slice(0, -1);
      const local = (i: number) => f.staff[i]!.phone.replace(/^\+88/, '');
      const cls = f.classLevel;
      expect(lines).toEqual([
        'student_code,staff_phone,device_id,name,class,section,role,status',
        `SHS-2026-0001,,101,ছাত্র 1,${cls.nameBn},A,,current`,
        `SHS-2026-0002,,20260002,ছাত্র 2,${cls.nameBn},A,,suggested`,
        `SHS-2026-0003,,20260003,ছাত্র 3,${cls.nameBn},A,,suggested`,
        `SHS-2026-0004,,20260004,ছাত্র 1,${cls.nameBn},B,,suggested`,
        `,${local(0)},9500,Staff 1,,,প্রশাসক,current`,
        `,${local(1)},9001,কর্মী দুই,,,শিক্ষক,suggested`,
        `,${local(2)},9002,Staff 3,,,শিক্ষক,suggested`,
      ]);
      for (const line of lines)
        expect(line.split(',').slice(0, 3).join()).toMatch(/^[\x20-\x7e]*$/);

      const en = await text(
        http(h).get('/attendance/device-people/csv').query({ locale: 'en' }).set(bearer(f.admin)),
      );
      const enLines = en.slice(1).split('\r\n');
      expect(enLines[0]).toBe(lines[0]);
      expect(enLines[1]).toBe(`SHS-2026-0001,,101,Student 1,${cls.nameEn},A,,current`);
      expect(enLines[6]).toBe(`,${local(1)},9001,Staff 2,,,Teacher,suggested`);
    });

    it('import preview: every error code, OK and UNCHANGED, blank rows skipped; nothing written', async () => {
      const f = await fixture();
      const device = await addDevice(f.admin);
      const extra = await createStudent(h, f.tenantId, 'EXTRA-1');
      const gone = await createStudent(h, f.tenantId, 'GONE-1');
      await inTenant(f.tenantId, (tx) =>
        tx.student.update({ where: { id: gone.id }, data: { deletedAt: new Date() } }),
      );
      await map(f.tenantId, { deviceUserId: '900', studentId: gone.id });
      await setId(f.admin, { studentId: f.students[3], deviceUserId: '201' });
      const commandsBefore = (await commands(f.tenantId, device.id)).length;
      const phone = (i: number) => f.staff[i]!.phone.replace(/^\+880/, '0');
      const csv = toCsv([
        ['Device_ID', 'notes', 'student_code', 'staff_phone'],
        ['301', '', '', ''],
        ['301', '', CODES[0]!, phone(1)],
        ['301', '', 'NOPE-1', ''],
        ['301', '', '', '01799999999'],
        ['0301', '', CODES[0]!, ''],
        ['', '', '', ''],
        ['302', '', CODES[1]!, ''],
        ['303', '', CODES[1]!.toLowerCase(), ''],
        ['401', '', CODES[2]!, ''],
        ['401', 'same number', '', phone(0)],
        // 900 belongs to a deleted student the file cannot move.
        ['900', '', 'extra-১', ''],
        [' ২০১ ', '', ` ${CODES[3]!.toLowerCase()} `, ''],
        // Excel dropped the phone's leading 0.
        ['9009', '', '', phone(2).slice(1)],
        // The deleted student cannot be named.
        ['', '', 'GONE-1', ''],
      ]);
      const preview = await imported(f.admin, csv, false);
      expect(preview.applied).toBe(false);
      expect(preview.queued).toBe(0);
      expect(preview.counts).toEqual({ ok: 1, unchanged: 1, error: 11 });
      expect(preview.rows.map((r) => [r.row, r.status, r.error ?? null])).toEqual([
        [2, 'ERROR', 'NO_PERSON_KEY'],
        [3, 'ERROR', 'BOTH_KEYS'],
        [4, 'ERROR', 'UNKNOWN_STUDENT'],
        [5, 'ERROR', 'UNKNOWN_STAFF'],
        [6, 'ERROR', 'BAD_DEVICE_ID'],
        [8, 'ERROR', 'DUPLICATE_PERSON'],
        [9, 'ERROR', 'DUPLICATE_PERSON'],
        [10, 'ERROR', 'DUPLICATE_ID'],
        [11, 'ERROR', 'DUPLICATE_ID'],
        [12, 'ERROR', 'TAKEN'],
        [13, 'UNCHANGED', null],
        [14, 'OK', null],
        [15, 'ERROR', 'UNKNOWN_STUDENT'],
      ]);
      expect(preview.rows[9]).toEqual({
        row: 12,
        person: {
          kind: 'STUDENT',
          id: extra.id,
          name: 'EXTRA-1',
          nameBn: null,
          studentCode: 'EXTRA-1',
        },
        previous: null,
        deviceUserId: '900',
        status: 'ERROR',
        error: 'TAKEN',
      });
      expect(preview.rows[10]).toEqual({
        row: 13,
        person: studentRef(f, 3),
        previous: '201',
        deviceUserId: '201',
        status: 'UNCHANGED',
      });
      expect(preview.rows[11]).toMatchObject({
        person: staffRef(f, 2),
        previous: null,
        deviceUserId: '9009',
      });
      expect(await mapped(f.tenantId)).toEqual({ [gone.id]: '900', [f.students[3]!]: '201' });
      expect((await commands(f.tenantId, device.id)).length).toBe(commandsBefore);
      expect(await audits(f.tenantId, 'device_people_batch')).toEqual([]);
    });

    it('import apply: only the OK rows, a swap in one file, commands for new IDs; a re-upload is all UNCHANGED', async () => {
      const f = await fixture();
      const device = await addDevice(f.admin);
      for (const [i, id] of ['101', '102', '', '104'].entries()) {
        if (id) await setId(f.admin, { studentId: f.students[i], deviceUserId: id });
      }
      const before = (await commands(f.tenantId, device.id)).length;
      const rows = [
        ['student_code', 'staff_phone', 'device_id'],
        [CODES[0]!, '', '102'],
        [CODES[1]!, '', '101'],
        [CODES[2]!, '', '103'],
        [CODES[3]!, '', ''],
      ];
      const csv = toCsv([...rows, ['NOPE', '', '105']]);
      const applied = await imported(f.admin, csv, true);
      expect(applied).toMatchObject({
        applied: true,
        counts: { ok: 4, unchanged: 0, error: 1 },
        queued: 3,
      });
      expect(await mapped(f.tenantId)).toEqual({
        [f.students[0]!]: '102',
        [f.students[1]!]: '101',
        [f.students[2]!]: '103',
      });
      expect((await commands(f.tenantId, device.id)).slice(before).map((c) => c.payload)).toEqual([
        'DATA UPDATE USERINFO PIN=101\tName=Student 2',
        'DATA UPDATE USERINFO PIN=102\tName=Student 1',
        'DATA UPDATE USERINFO PIN=103\tName=Student 3',
      ]);
      expect((await audits(f.tenantId, 'device_people_batch')).map((a) => a.newValues)).toEqual([
        {
          source: 'IMPORT',
          changes: [
            { studentId: f.students[0], from: '101', to: '102' },
            { studentId: f.students[1], from: '102', to: '101' },
            { studentId: f.students[2], from: null, to: '103' },
            { studentId: f.students[3], from: '104', to: null },
          ],
        },
      ]);

      const again = await imported(f.admin, toCsv(rows), false);
      expect(again.rows.map((r) => r.status)).toEqual([
        'UNCHANGED',
        'UNCHANGED',
        'UNCHANGED',
        'UNCHANGED',
      ]);
      expect((await imported(f.admin, toCsv(rows), true)).queued).toBe(0);

      // The apply checks against the database as it is then, not as the preview saw it.
      const next = toCsv([rows[0]!, [CODES[3]!, '', '105']]);
      expect((await imported(f.admin, next, false)).rows[0]!.status).toBe('OK');
      await setId(f.admin, { staffUserId: f.staff[0]!.id, deviceUserId: '105' });
      const late = await imported(f.admin, next, true);
      expect(late.rows[0]).toMatchObject({ status: 'ERROR', error: 'TAKEN' });
      expect(late.queued).toBe(0);
      expect((await mapped(f.tenantId))[f.students[3]!]).toBeUndefined();
    });

    it('the file: CSV only, a header with the columns, 1 to 5000 rows, at most 1 MB', async () => {
      const f = await fixture();
      const code = async (res: request.Test, status: number) =>
        ((await res.expect(status)).body as { code: string }).code;
      expect(
        await code(http(h).post('/attendance/device-people/import').set(bearer(f.admin)), 422),
      ).toBe('FILE_MISSING');
      const ok = toCsv([
        ['student_code', 'device_id'],
        [CODES[0]!, '101'],
      ]);
      expect(await code(upload(f.admin, ok, false, 'ids.xlsx'), 422)).toBe('FILE_TYPE');
      expect(await code(upload(f.admin, toCsv([['name', 'device_id']]), false), 422)).toBe(
        'MISSING_COLUMNS',
      );
      expect(await code(upload(f.admin, toCsv([['student_code']]), false), 422)).toBe(
        'MISSING_COLUMNS',
      );
      expect(await code(upload(f.admin, toCsv([['student_code', 'device_id']]), false), 422)).toBe(
        'NO_DATA_ROWS',
      );
      const many = toCsv([
        ['student_code', 'device_id'],
        ...Array.from({ length: 5001 }, (_, i) => [`X-${i}`, '']),
      ]);
      expect(await code(upload(f.admin, many, false), 422)).toBe('TOO_MANY_ROWS');
      await upload(f.admin, `student_code,device_id\r\n${'x'.repeat(1024 * 1024)}`, false).expect(
        413,
      );
      expect((await imported(f.admin, ok, false)).counts).toEqual({
        ok: 1,
        unchanged: 0,
        error: 0,
      });
    });
  });

  describe('people no longer active, still on the devices', () => {
    it('listed once a device confirmed them; removal refuses active people, queues USER_DELETE on active devices and frees the ID', async () => {
      const f = await fixture();
      const on = await addDevice(f.admin);
      const off = await addDevice(f.admin, false);
      const reader = sim(on);
      await setId(f.admin, { studentId: f.students[0], deviceUserId: '101' });
      await setId(f.admin, { studentId: f.students[1], deviceUserId: '102' });
      await setId(f.admin, { staffUserId: f.staff[1]!.id, deviceUserId: '9001' });
      clock.set(new Date(T0.getTime() + 60_000));
      await reader.poll();
      // Never confirmed by a device: not listed.
      await setId(f.admin, { studentId: f.students[2], deviceUserId: '103' });
      await inTenant(f.tenantId, async (tx) => {
        await tx.student.update({ where: { id: f.students[0] }, data: { status: 'INACTIVE' } });
        await tx.student.update({ where: { id: f.students[2] }, data: { deletedAt: new Date() } });
        await tx.membership.updateMany({
          where: { userId: f.staff[1]!.id },
          data: { status: 'DISABLED' },
        });
      });
      const stale = async () =>
        (await get(f.admin, '/attendance/device-people/stale').expect(200))
          .body as StaleDevicePerson[];
      const at = new Date(T0.getTime() + 60_000).toISOString();
      expect(await stale()).toEqual([
        { person: studentRef(f, 0), deviceUserId: '101', lastSyncAt: at },
        { person: staffRef(f, 1), deviceUserId: '9001', lastSyncAt: at },
      ]);

      const refused = await post(f.admin, '/attendance/device-people/remove-from-devices', {
        deviceUserIds: ['101', '102'],
      }).expect(409);
      expect(refused.body).toEqual({
        statusCode: 409,
        code: 'PERSON_ACTIVE',
        message: 'These IDs belong to active people',
        people: [{ deviceUserId: '102', person: studentRef(f, 1) }],
      });
      expect(Object.values(await mapped(f.tenantId)).sort()).toEqual(['101', '102', '103', '9001']);

      const before = (await commands(f.tenantId, on.id)).length;
      expect(
        (
          await post(f.admin, '/attendance/device-people/remove-from-devices', {
            deviceUserIds: ['9001', '101'],
          }).expect(200)
        ).body,
      ).toEqual({ freed: ['101', '9001'], queued: 2 } satisfies RemoveFromDevicesResult);
      expect((await commands(f.tenantId, on.id)).slice(before)).toEqual([
        {
          kind: 'USER_DELETE',
          deviceUserId: '9001',
          payload: 'DATA DELETE USERINFO PIN=9001',
          status: 'PENDING',
        },
        {
          kind: 'USER_DELETE',
          deviceUserId: '101',
          payload: 'DATA DELETE USERINFO PIN=101',
          status: 'PENDING',
        },
      ]);
      expect(await commands(f.tenantId, off.id)).toEqual([]);
      expect(Object.values(await mapped(f.tenantId)).sort()).toEqual(['102', '103']);
      expect((await audits(f.tenantId, 'device_people_batch')).map((a) => a.newValues)).toEqual([
        {
          source: 'REMOVE_FROM_DEVICES',
          deviceUserIds: ['9001', '101'],
          freed: [
            { studentId: f.students[0], deviceUserId: '101' },
            { staffUserId: f.staff[1]!.id, deviceUserId: '9001' },
          ],
          queued: 2,
        },
      ]);
      expect(await stale()).toEqual([]);
      // The device removes them (and adds 103 meanwhile, whose student was deleted).
      await reader.poll();
      expect((await stale()).map((p) => p.deviceUserId)).toEqual(['103']);

      // 101 is free again. Its new holder leaves before any device confirmed them: the earlier
      // person's add was followed by a confirmed removal, so 101 is not listed.
      await setId(f.admin, { studentId: f.students[3], deviceUserId: '101' });
      await inTenant(f.tenantId, (tx) =>
        tx.student.update({ where: { id: f.students[3] }, data: { status: 'INACTIVE' } }),
      );
      expect((await stale()).map((p) => p.deviceUserId)).toEqual(['103']);
      await post(f.admin, '/attendance/device-people/remove-from-devices', {
        deviceUserIds: [],
      }).expect(400);
    });
  });

  it('staff range check: current students whose code number is within start to start + 999', async () => {
    const f = await fixture(['S-9001', 'S-10000', 'S-10001', 'S-9500']);
    const gone = await createStudent(h, f.tenantId, 'S-9002');
    await inTenant(f.tenantId, (tx) =>
      tx.student.update({ where: { id: gone.id }, data: { status: 'INACTIVE' } }),
    );
    const check = (start: string) =>
      get(f.admin, '/attendance/device-people/staff-range-check', { start });
    expect((await check('9001').expect(200)).body).toEqual({
      start: 9001,
      studentDefaultsInRange: 3,
    });
    expect((await check('৯৫০০').expect(200)).body).toEqual({
      start: 9500,
      studentDefaultsInRange: 3,
    });
    expect((await check('20000').expect(200)).body.studentDefaultsInRange).toBe(0);
    await check('99').expect(400);
  });

  it("institute isolation: B sees none of A's people and cannot set them; IDs are per institute", async () => {
    const a = await fixture();
    const b = await fixture();
    await setId(a.admin, { studentId: a.students[0], deviceUserId: '101' });
    const list = await people(b.admin);
    expect(list.people.map((p) => p.id)).toEqual([...b.students, ...b.staff.map((s) => s.id)]);
    await put(b.admin, { studentId: a.students[1], deviceUserId: '102' }).expect(404);
    const res = await put(b.admin, { staffUserId: a.staff[0]!.id, deviceUserId: '102' }).expect(
      422,
    );
    expect(res.body.code).toBe('NOT_STAFF');
    // The same number is free in B.
    await setId(b.admin, { studentId: b.students[0], deviceUserId: '101' });
    // A code names B's own student; removing an ID in B leaves A's alone.
    const preview = await imported(
      b.admin,
      toCsv([
        ['student_code', 'device_id'],
        [CODES[0]!, '101'],
      ]),
      false,
    );
    expect(preview.rows[0]).toMatchObject({ status: 'UNCHANGED', person: { id: b.students[0] } });
    await inTenant(b.tenantId, (tx) =>
      tx.student.update({ where: { id: b.students[0] }, data: { status: 'INACTIVE' } }),
    );
    await post(b.admin, '/attendance/device-people/remove-from-devices', {
      deviceUserIds: ['101'],
    }).expect(200);
    expect(await mapped(a.tenantId)).toEqual({ [a.students[0]!]: '101' });
    expect(await mapped(b.tenantId)).toEqual({});
    expect((await get(b.admin, '/attendance/device-people/collisions').expect(200)).body).toEqual(
      [],
    );
  });
});

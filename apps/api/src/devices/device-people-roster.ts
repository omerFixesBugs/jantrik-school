import { Injectable } from '@nestjs/common';
import { Prisma } from '@jantrik/db';
import {
  STAFF_ROLE_VALUES,
  defaultDeviceIds,
  type DefaultIds,
  type DevicePersonKind,
  type DevicePersonRef,
  type StaffRole,
} from '@jantrik/shared';
import { AttendanceSettingsService } from '../attendance/attendance-settings.service.js';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import { Db } from '../tenancy/db.service.js';
import { activeDeviceIds, deviceUsers, idsOnDevices, queueUpserts } from './device-users.js';

/** Audit entities: one person's ID (PUT), and a batch (defaults, import, removal). */
export const DEVICE_PERSON = 'device_person';
export const DEVICE_PEOPLE_BATCH = 'device_people_batch';

/** A person's key in the ID rules: `STUDENT:<student id>` or `STAFF:<user id>`. */
export const personKey = (kind: DevicePersonKind, id: string) => `${kind}:${id}`;
export const kindOfKey = (key: string): DevicePersonKind =>
  key.startsWith('STUDENT:') ? 'STUDENT' : 'STAFF';
const idOfKey = (key: string) => key.slice(key.indexOf(':') + 1);
/** The device_people columns that name the person behind a key. */
export function personColumns(key: string): { studentId: string } | { staffUserId: string } {
  const id = idOfKey(key);
  return kindOfKey(key) === 'STUDENT' ? { studentId: id } : { staffUserId: id };
}

export const studentRef = (s: {
  id: string;
  nameBn: string | null;
  nameEn: string | null;
  studentCode: string;
}): DevicePersonRef => ({
  kind: 'STUDENT',
  id: s.id,
  name: s.nameEn ?? s.nameBn ?? '',
  nameBn: s.nameBn,
  studentCode: s.studentCode,
});

export const staffPersonRef = (userId: string, p: { name: string; nameBn: string | null }) =>
  ({ kind: 'STAFF', id: userId, name: p.name, nameBn: p.nameBn }) satisfies DevicePersonRef;

/** Selects a device_people row with whoever it belongs to (names from students and profiles). */
export const HOLDER_SELECT = {
  id: true,
  deviceUserId: true,
  studentId: true,
  staffUserId: true,
  student: {
    select: {
      id: true,
      nameBn: true,
      nameEn: true,
      studentCode: true,
      status: true,
      deletedAt: true,
    },
  },
  staffProfile: { select: { name: true, nameBn: true } },
} satisfies Prisma.DevicePersonSelect;
export type HolderRow = Prisma.DevicePersonGetPayload<{ select: typeof HOLDER_SELECT }>;

export const holderKey = (r: HolderRow) =>
  r.studentId ? personKey('STUDENT', r.studentId) : personKey('STAFF', r.staffUserId!);
export const holderRef = (r: HolderRow): DevicePersonRef =>
  r.student ? studentRef(r.student) : staffPersonRef(r.staffUserId!, r.staffProfile!);

export interface RosterStudent {
  key: string;
  id: string;
  nameBn: string | null;
  nameEn: string | null;
  studentCode: string;
  classLevel: { id: string; nameBn: string; nameEn: string };
  section: { id: string; name: string } | null;
  deviceUserId: string | null;
}

export interface RosterStaff {
  key: string;
  /** The user id. */
  id: string;
  name: string;
  nameBn: string | null;
  /** E.164. */
  phone: string;
  roles: StaffRole[];
  deviceUserId: string | null;
}

export interface Roster {
  /** Active students enrolled in the current year, by class, section, roll and code. */
  students: RosterStudent[];
  /** Staff with an active staff role and a profile, in the order they were added. */
  staff: RosterStaff[];
  /** Every device_people row by ID, also people no longer active. */
  holders: Map<string, HolderRow>;
  /** What "assign default IDs" gives everyone without an ID now. */
  defaults: DefaultIds;
  /** Key → the ID from `defaults`. */
  suggested: Map<string, string>;
  /** IDs an active device still has someone under (see `onDevice`). */
  onDevice: Map<string, OnDevice>;
  refs: Map<string, DevicePersonRef>;
}

/** Someone an active device has under an ID (its last confirmed command for it was an add). */
export interface OnDevice {
  /** Its holder; when nobody holds it, the person it was last taken from. */
  key: string;
  person: DevicePersonRef;
  /** The active devices that have them. */
  deviceIds: string[];
  /** When a device last confirmed adding them. */
  lastSyncAt: Date;
  /** A removal is queued after that add and not confirmed yet. */
  removing: boolean;
}

export const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/** 409 DEVICE_ID_TAKEN, naming the holder when known (always someone of this institute). */
export const deviceIdTaken = (holder: DevicePersonRef | null) =>
  apiError(409, 'DEVICE_ID_TAKEN', 'Someone else here has this device ID', { holder });

/** 409 ID_STILL_ON_DEVICE: a device still has `previous` under the ID. */
export const idStillOnDevice = (previous: DevicePersonRef) =>
  apiError(
    409,
    'ID_STILL_ON_DEVICE',
    'A device still has someone else under this ID; remove it from the devices first',
    { previous },
  );

/**
 * The people who get device IDs, who holds which ID, and the defaults, read in the request
 * transaction. Also the lock and the command queueing every device-people write shares.
 */
@Injectable()
export class DevicePeopleRoster {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly settings: AttendanceSettingsService,
  ) {}

  /**
   * The institute's device-people lock, until the request ends. Every write in this API takes it
   * before reading, so its checks (who holds an ID) and its writes see one another whole.
   */
  async lock(): Promise<void> {
    await this.db.tx
      .$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('device-people:' || app_current_tenant_id()::text, 0))`;
  }

  async load(): Promise<Roster> {
    const tx = this.db.tx;
    const enrolments = await tx.enrolment.findMany({
      where: { academicYear: { isCurrent: true }, student: { deletedAt: null, status: 'ACTIVE' } },
      orderBy: [
        { classLevel: { sortOrder: 'asc' } },
        { section: { name: 'asc' } },
        { roll: { sort: 'asc', nulls: 'last' } },
        { student: { studentCode: 'asc' } },
      ],
      select: {
        classLevel: { select: { id: true, nameBn: true, nameEn: true } },
        section: { select: { id: true, name: true } },
        student: { select: { id: true, nameBn: true, nameEn: true, studentCode: true } },
      },
    });
    const profiles = await tx.staffProfile.findMany({
      orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
      select: { userId: true, name: true, nameBn: true, phone: true },
    });
    const roles = await this.activeStaffRoles();
    const rows = await tx.devicePerson.findMany({ select: HOLDER_SELECT });
    const holders = new Map(rows.map((r) => [r.deviceUserId, r]));
    const idOf = new Map(rows.map((r) => [holderKey(r), r.deviceUserId]));
    const refs = new Map(rows.map((r) => [holderKey(r), holderRef(r)]));

    const students = enrolments.map(({ student, classLevel, section }): RosterStudent => {
      const key = personKey('STUDENT', student.id);
      refs.set(key, studentRef(student));
      return { key, ...student, classLevel, section, deviceUserId: idOf.get(key) ?? null };
    });
    const staff = profiles.flatMap((p): RosterStaff[] => {
      const mine = roles.get(p.userId);
      if (!mine) return [];
      const key = personKey('STAFF', p.userId);
      refs.set(key, staffPersonRef(p.userId, p));
      return [
        {
          key,
          id: p.userId,
          name: p.name,
          nameBn: p.nameBn,
          phone: p.phone,
          roles: STAFF_ROLE_VALUES.filter((r) => mine.has(r)),
          deviceUserId: idOf.get(key) ?? null,
        },
      ];
    });
    const onDevice = await this.onDevice();
    for (const o of onDevice.values()) if (!refs.has(o.key)) refs.set(o.key, o.person);
    const { settings } = await this.settings.load();
    const defaults = defaultDeviceIds({
      students: students.map((s) => ({ key: s.key, code: s.studentCode, current: s.deviceUserId })),
      staff: staff.map((s) => ({ key: s.key, current: s.deviceUserId })),
      held: new Set(holders.keys()),
      onDevice: new Map([...onDevice].map(([id, o]) => [id, o.key])),
      staffStart: settings.staffDeviceIdStart,
    });
    const suggested = new Map(defaults.assigned.map((a) => [a.key, a.deviceUserId]));
    return { students, staff, holders, defaults, suggested, onDevice, refs };
  }

  /**
   * IDs (all, or these) whose last confirmed command on some active device was an add, and who
   * the devices have under them: the holder, or when nobody holds the ID, the person it was last
   * taken from (by a change, a clear, an import or a removal, read from their audit rows). IDs
   * nobody here is known for (rows written outside this API) are left out.
   */
  async onDevice(ids?: string[]): Promise<Map<string, OnDevice>> {
    const tx = this.db.tx;
    const found = await idsOnDevices(tx, ids);
    if (found.size === 0) return new Map();
    const held = await tx.devicePerson.findMany({
      where: { deviceUserId: { in: [...found.keys()] } },
      select: HOLDER_SELECT,
    });
    const keyOf = new Map(held.map((h) => [h.deviceUserId, holderKey(h)]));
    const refs = new Map(held.map((h) => [holderKey(h), holderRef(h)]));
    const unheld = [...found.keys()].filter((id) => !keyOf.has(id));
    if (unheld.length > 0) {
      for (const [id, key] of await this.lastTakenFrom(unheld)) keyOf.set(id, key);
      const missing = [...new Set(keyOf.values())].filter((k) => !refs.has(k));
      const studentIds = missing.filter((k) => kindOfKey(k) === 'STUDENT').map(idOfKey);
      const staffIds = missing.filter((k) => kindOfKey(k) === 'STAFF').map(idOfKey);
      for (const st of await tx.student.findMany({
        where: { id: { in: studentIds } },
        select: { id: true, nameBn: true, nameEn: true, studentCode: true },
      })) {
        refs.set(personKey('STUDENT', st.id), studentRef(st));
      }
      for (const p of await tx.staffProfile.findMany({
        where: { userId: { in: staffIds } },
        select: { userId: true, name: true, nameBn: true },
      })) {
        refs.set(personKey('STAFF', p.userId), staffPersonRef(p.userId, p));
      }
    }
    const out = new Map<string, OnDevice>();
    for (const [deviceUserId, on] of found) {
      const key = keyOf.get(deviceUserId);
      const person = key === undefined ? undefined : refs.get(key);
      if (key === undefined || person === undefined) continue;
      out.set(deviceUserId, { key, person, ...on });
    }
    return out;
  }

  /** For IDs nobody holds: the person each was last taken from, by the audit rows. */
  private async lastTakenFrom(ids: string[]): Promise<Map<string, string>> {
    const rows = await this.db.tx.$queryRaw<
      { device_user_id: string; student_id: string | null; staff_user_id: string | null }[]
    >`
      SELECT DISTINCT ON (r.device_user_id) r.device_user_id, r.student_id, r.staff_user_id
      FROM (
        SELECT a.old_values->>'deviceUserId' AS device_user_id,
               a.old_values->>'studentId' AS student_id,
               a.old_values->>'staffUserId' AS staff_user_id, a.created_at, a.id
        FROM audit_logs a
        WHERE a.entity = ${DEVICE_PERSON} AND a.action IN ('UPDATE', 'DELETE')
        UNION ALL
        SELECT x->>'from', x->>'studentId', x->>'staffUserId', a.created_at, a.id
        FROM audit_logs a CROSS JOIN LATERAL jsonb_array_elements(a.new_values->'changes') x
        WHERE a.entity = ${DEVICE_PEOPLE_BATCH} AND a.new_values->>'source' = 'IMPORT'
        UNION ALL
        SELECT x->>'deviceUserId', x->>'studentId', x->>'staffUserId', a.created_at, a.id
        FROM audit_logs a CROSS JOIN LATERAL jsonb_array_elements(a.new_values->'freed') x
        WHERE a.entity = ${DEVICE_PEOPLE_BATCH} AND a.new_values->>'source' = 'REMOVE_FROM_DEVICES'
      ) r
      WHERE r.device_user_id = ANY(${ids}::text[])
      ORDER BY r.device_user_id, r.created_at DESC, r.id DESC`;
    return new Map(
      rows.map((r) => [
        r.device_user_id,
        r.student_id ? personKey('STUDENT', r.student_id) : personKey('STAFF', r.staff_user_id!),
      ]),
    );
  }

  /** User id → their ACTIVE staff roles here. */
  async activeStaffRoles(userIds?: string[]): Promise<Map<string, Set<StaffRole>>> {
    const rows = await this.db.tx.membership.findMany({
      where: {
        ...(userIds ? { userId: { in: userIds } } : {}),
        status: 'ACTIVE',
        role: { in: [...STAFF_ROLE_VALUES] },
      },
      select: { userId: true, role: true },
    });
    const out = new Map<string, Set<StaffRole>>();
    for (const m of rows) {
      const set = out.get(m.userId) ?? new Set<StaffRole>();
      set.add(m.role as StaffRole);
      out.set(m.userId, set);
    }
    return out;
  }

  /**
   * Insert device_people rows (people without one). The lock makes a clash unlikely; the unique
   * index is the real guard and answers DEVICE_ID_TAKEN.
   */
  async insert(rows: { key: string; deviceUserId: string }[]): Promise<void> {
    if (rows.length === 0) return;
    const me = this.context.requirePrincipal();
    try {
      await this.db.tx.devicePerson.createMany({
        data: rows.map((r) => ({
          tenantId: me.tenantId!,
          ...personColumns(r.key),
          deviceUserId: r.deviceUserId,
          createdById: me.userId,
          updatedById: me.userId,
        })),
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw deviceIdTaken(null);
      throw error;
    }
  }

  /** USER_UPSERT for these IDs' people (active ones only) on every active device. */
  async queueUpserts(deviceUserIds: string[]): Promise<number> {
    if (deviceUserIds.length === 0) return 0;
    const tx = this.db.tx;
    const me = this.context.requirePrincipal();
    const { queued } = await queueUpserts(tx, {
      tenantId: me.tenantId!,
      deviceIds: await activeDeviceIds(tx),
      users: await deviceUsers(tx, deviceUserIds),
      createdById: me.userId,
    });
    return queued;
  }
}

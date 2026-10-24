import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import {
  STAFF_RANGE_SIZE,
  defaultStudentDeviceId,
  deviceIdCollisions,
  userDeletePayload,
  type DeviceDefaultsResult,
  type DeviceIdCollisionView,
  type DeviceIdPerson,
  type DevicePeopleList,
  type DevicePersonKind,
  type DevicePersonRow,
  type DeviceSyncState,
  type RemoveFromDevicesResult,
  type SetDeviceIdResult,
  type StaffRangeCheck,
  type StaleDevicePerson,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';
import { Db } from '../tenancy/db.service.js';
import {
  DevicePeopleRoster,
  HOLDER_SELECT,
  deviceIdTaken,
  holderKey,
  holderRef,
  isUniqueViolation,
  kindOfKey,
  personColumns,
  personKey,
  type HolderRow,
} from './device-people-roster.js';
import { activeDeviceIds } from './device-users.js';

/** Batches (defaults, import, removal) are audited as one row listing every change. */
export const DEVICE_PEOPLE_BATCH = 'device_people_batch';

/**
 * People ↔ device IDs (OWNER/ADMIN): the list, setting one ID, collisions, default IDs, people no
 * longer active who are still on the devices, and the staff range check. Writes take the
 * institute's device-people lock first; adding an ID queues USER_UPSERT on the active devices,
 * clearing one queues nothing (the device keeps their fingerprints).
 */
@Injectable()
export class DevicePeopleService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly roster: DevicePeopleRoster,
  ) {}

  async list(query: {
    kind?: DevicePersonKind;
    unmapped?: boolean;
    sectionId?: string;
  }): Promise<DevicePeopleList> {
    const r = await this.roster.load();
    const sync = await this.syncStates();
    const ids = (p: { key: string; deviceUserId: string | null }) => ({
      deviceUserId: p.deviceUserId,
      suggested: r.suggested.get(p.key) ?? null,
      sync: p.deviceUserId === null ? 'NONE' : (sync.get(p.deviceUserId) ?? 'NONE'),
    });
    const people: DevicePersonRow[] = [];
    const wanted = (p: { deviceUserId: string | null }) => !query.unmapped || !p.deviceUserId;
    if (query.kind !== 'STAFF') {
      for (const s of r.students) {
        if (!wanted(s) || (query.sectionId && s.section?.id !== query.sectionId)) continue;
        people.push({
          kind: 'STUDENT',
          id: s.id,
          nameBn: s.nameBn,
          nameEn: s.nameEn,
          studentCode: s.studentCode,
          classLevel: s.classLevel,
          section: s.section,
          ...ids(s),
        });
      }
    }
    if (query.kind !== 'STUDENT' && !query.sectionId) {
      for (const s of r.staff) {
        if (!wanted(s)) continue;
        people.push({
          kind: 'STAFF',
          id: s.id,
          name: s.name,
          nameBn: s.nameBn,
          roles: s.roles,
          ...ids(s),
        });
      }
    }
    return {
      people,
      counts: {
        students: r.students.length,
        studentsUnmapped: r.students.filter((s) => !s.deviceUserId).length,
        staff: r.staff.length,
        staffUnmapped: r.staff.filter((s) => !s.deviceUserId).length,
      },
    };
  }

  /**
   * Set (or with null clear) one person's ID. A student must exist; a staff member must have an
   * active staff role and a profile. An ID someone else holds is DEVICE_ID_TAKEN, naming them.
   */
  async set(input: {
    studentId?: string;
    staffUserId?: string;
    deviceUserId: string | null;
  }): Promise<SetDeviceIdResult> {
    const tx = this.db.tx;
    await this.roster.lock();
    const key = input.studentId
      ? await this.studentKey(input.studentId)
      : await this.staffKey(input.staffUserId!);
    const columns = personColumns(key);
    const existing = await tx.devicePerson.findFirst({ where: columns });
    const previous = existing?.deviceUserId ?? null;
    const next = input.deviceUserId;
    // Unchanged, or cleared: nothing is sent (a device keeps a cleared person's fingerprints).
    const quiet = { deviceUserId: next, previous, reenrol: false, queued: 0 };
    if (next === previous) return quiet;
    if (next === null) {
      await tx.devicePerson.delete({ where: { id: existing!.id } });
      await this.audit.record({
        entity: 'device_person',
        entityId: existing!.id,
        action: 'DELETE',
        oldValues: { ...columns, deviceUserId: previous },
      });
      return quiet;
    }
    const holder = await tx.devicePerson.findFirst({
      where: { deviceUserId: next },
      select: HOLDER_SELECT,
    });
    if (holder) throw deviceIdTaken(holderRef(holder));
    const me = this.context.requirePrincipal();
    let id: string;
    try {
      id = existing
        ? (
            await tx.devicePerson.update({
              where: { id: existing.id },
              data: { deviceUserId: next, updatedById: me.userId },
            })
          ).id
        : (
            await tx.devicePerson.create({
              data: {
                tenantId: me.tenantId!,
                ...columns,
                deviceUserId: next,
                createdById: me.userId,
                updatedById: me.userId,
              },
            })
          ).id;
    } catch (error) {
      if (isUniqueViolation(error)) throw deviceIdTaken(null);
      throw error;
    }
    await this.audit.record({
      entity: 'device_person',
      entityId: id,
      action: existing ? 'UPDATE' : 'CREATE',
      ...(existing ? { oldValues: { ...columns, deviceUserId: previous } } : {}),
      newValues: { ...columns, deviceUserId: next },
    });
    return {
      deviceUserId: next,
      previous,
      reenrol: previous !== null,
      queued: await this.roster.queueUpserts([next]),
    };
  }

  /**
   * Numbers someone without an ID wants (their student code's digits) while another person holds
   * them, or that two such students want. Holders include people no longer active.
   */
  async collisions(): Promise<DeviceIdCollisionView[]> {
    const r = await this.roster.load();
    const people: DeviceIdPerson[] = [
      ...r.students.map((s) => ({
        key: s.key,
        kind: 'STUDENT' as const,
        current: s.deviceUserId,
        wanted: s.deviceUserId === null ? defaultStudentDeviceId(s.studentCode) : null,
      })),
      ...r.staff.map((s) => ({
        key: s.key,
        kind: 'STAFF' as const,
        current: s.deviceUserId,
        wanted: s.deviceUserId === null ? (r.suggested.get(s.key) ?? null) : null,
      })),
    ];
    const listed = new Set(people.map((p) => p.key));
    for (const h of r.holders.values()) {
      const key = holderKey(h);
      if (!listed.has(key)) {
        people.push({ key, kind: kindOfKey(key), current: h.deviceUserId, wanted: null });
      }
    }
    return deviceIdCollisions(people).map((c) => ({
      deviceUserId: c.deviceUserId,
      wantedBy: c.wantedBy.map((k) => r.refs.get(k)!),
      heldBy: c.heldBy === null ? null : r.refs.get(c.heldBy)!,
    }));
  }

  /**
   * Default IDs for people without one (students: their code's digits; staff: from the staff
   * start, skipping every student code's number). A dry run writes nothing; otherwise the new
   * rows are written, audited as one batch and sent to the active devices.
   */
  async defaults(input: {
    kind: DevicePersonKind | 'ALL';
    dryRun: boolean;
  }): Promise<DeviceDefaultsResult> {
    if (!input.dryRun) await this.roster.lock();
    const r = await this.roster.load();
    const wanted = (key: string) => input.kind === 'ALL' || kindOfKey(key) === input.kind;
    const assigned = r.defaults.assigned.filter((a) => wanted(a.key));
    const result: DeviceDefaultsResult = {
      assigned: assigned.map((a) => ({ person: r.refs.get(a.key)!, deviceUserId: a.deviceUserId })),
      conflicts: r.defaults.conflicts
        .filter((c) => wanted(c.key))
        .map((c) => {
          const holder = c.reason === 'TAKEN' ? r.holders.get(c.deviceUserId!) : undefined;
          return {
            person: r.refs.get(c.key)!,
            deviceUserId: c.deviceUserId,
            reason: c.reason,
            heldBy: holder ? holderRef(holder) : null,
          };
        }),
      queued: 0,
    };
    if (input.dryRun || assigned.length === 0) return result;
    await this.roster.insert(assigned);
    await this.audit.record({
      entity: DEVICE_PEOPLE_BATCH,
      entityId: randomUUID(),
      action: 'CREATE',
      newValues: {
        source: 'DEFAULTS',
        changes: assigned.map((a) => ({ ...personColumns(a.key), from: null, to: a.deviceUserId })),
      },
    });
    result.queued = await this.roster.queueUpserts(assigned.map((a) => a.deviceUserId));
    return result;
  }

  /**
   * People with an ID who are no longer active (a student deleted or not ACTIVE, staff without an
   * active staff role) and are still on a device: one confirmed it added them, and has not
   * confirmed removing them since.
   */
  async stale(): Promise<StaleDevicePerson[]> {
    const rows = await this.db.tx.devicePerson.findMany({ select: HOLDER_SELECT });
    const inactive = await this.inactive(rows);
    if (inactive.length === 0) return [];
    const sent = await this.db.tx.$queryRaw<{ device_user_id: string; last_sync_at: Date }[]>`
      SELECT c.device_user_id, max(coalesce(c.done_at, c.updated_at)) AS last_sync_at
      FROM device_commands c
      WHERE c.device_user_id = ANY(${inactive.map((r) => r.deviceUserId)}::text[])
        AND c.kind = 'USER_UPSERT' AND c.status = 'DONE'
        AND NOT EXISTS (SELECT 1 FROM device_commands x
                        WHERE x.tenant_id = c.tenant_id AND x.device_id = c.device_id
                          AND x.device_user_id = c.device_user_id
                          AND x.kind = 'USER_DELETE' AND x.status = 'DONE' AND x.seq > c.seq)
      GROUP BY c.device_user_id`;
    const lastSync = new Map(sent.map((s) => [s.device_user_id, s.last_sync_at]));
    return inactive
      .filter((r) => lastSync.has(r.deviceUserId))
      .sort((a, b) => Number(a.deviceUserId) - Number(b.deviceUserId))
      .map((r) => ({
        person: holderRef(r),
        deviceUserId: r.deviceUserId,
        lastSyncAt: lastSync.get(r.deviceUserId)!.toISOString(),
      }));
  }

  /**
   * Remove people from every active device (USER_DELETE) and free their IDs. Refused with
   * PERSON_ACTIVE, changing nothing, when any ID belongs to someone active.
   */
  async removeFromDevices(deviceUserIds: string[]): Promise<RemoveFromDevicesResult> {
    const tx = this.db.tx;
    await this.roster.lock();
    const rows = (
      await tx.devicePerson.findMany({
        where: { deviceUserId: { in: deviceUserIds } },
        select: HOLDER_SELECT,
      })
    ).sort((a, b) => Number(a.deviceUserId) - Number(b.deviceUserId));
    const inactive = new Set((await this.inactive(rows)).map((r) => r.deviceUserId));
    const active = rows.filter((r) => !inactive.has(r.deviceUserId));
    if (active.length > 0) {
      throw apiError(409, 'PERSON_ACTIVE', 'These IDs belong to active people', {
        people: active.map((r) => ({ deviceUserId: r.deviceUserId, person: holderRef(r) })),
      });
    }
    const me = this.context.requirePrincipal();
    const devices = await activeDeviceIds(tx);
    const commands = devices.flatMap((deviceId) =>
      deviceUserIds.map((deviceUserId) => ({
        tenantId: me.tenantId!,
        deviceId,
        kind: 'USER_DELETE' as const,
        deviceUserId,
        payload: userDeletePayload(deviceUserId),
        createdById: me.userId,
      })),
    );
    if (commands.length > 0) await tx.deviceCommand.createMany({ data: commands });
    if (rows.length > 0) {
      await tx.devicePerson.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    }
    await this.audit.record({
      entity: DEVICE_PEOPLE_BATCH,
      entityId: randomUUID(),
      action: 'DELETE',
      newValues: {
        source: 'REMOVE_FROM_DEVICES',
        deviceUserIds,
        freed: rows.map((r) => ({ ...personColumns(holderKey(r)), deviceUserId: r.deviceUserId })),
        queued: commands.length,
      },
    });
    return { freed: rows.map((r) => r.deviceUserId), queued: commands.length };
  }

  /** How many current students' code numbers fall in [start, start + 999]. */
  async staffRangeCheck(start: number): Promise<StaffRangeCheck> {
    const students = await this.db.tx.student.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        enrolments: { some: { academicYear: { isCurrent: true } } },
      },
      select: { studentCode: true },
    });
    const end = start + STAFF_RANGE_SIZE - 1;
    const studentDefaultsInRange = students.filter((s) => {
      const id = defaultStudentDeviceId(s.studentCode);
      return id !== null && Number(id) >= start && Number(id) <= end;
    }).length;
    return { start, studentDefaultsInRange };
  }

  /** Each ID's state across the active devices (IDs never sent anywhere are absent: NONE). */
  private async syncStates(): Promise<Map<string, DeviceSyncState>> {
    const tx = this.db.tx;
    const devices = await tx.attendanceDevice.count({ where: { isActive: true } });
    if (devices === 0) return new Map();
    const rows = await tx.$queryRaw<
      { device_user_id: string; pending: boolean; failed: boolean; done: number }[]
    >`
      SELECT l.device_user_id, bool_or(l.pending) AS pending,
             bool_or(l.latest = 'FAILED') AS failed,
             (count(*) FILTER (WHERE l.latest = 'DONE'))::int AS done
      FROM (
        SELECT c.device_id, c.device_user_id,
               (array_agg(c.status::text ORDER BY c.seq DESC))[1] AS latest,
               bool_or(c.status IN ('PENDING', 'SENT')) AS pending
        FROM device_commands c
        JOIN attendance_devices d ON d.tenant_id = c.tenant_id AND d.id = c.device_id
        WHERE d.is_active AND c.kind = 'USER_UPSERT'
        GROUP BY c.device_id, c.device_user_id
      ) l
      GROUP BY l.device_user_id`;
    return new Map(
      rows.map((r) => [
        r.device_user_id,
        r.pending ? 'PENDING' : r.failed ? 'FAILED' : r.done === devices ? 'DONE' : 'NONE',
      ]),
    );
  }

  /** The rows whose person is no longer active. */
  private async inactive(rows: HolderRow[]): Promise<HolderRow[]> {
    const staffIds = rows.flatMap((r) => (r.staffUserId ? [r.staffUserId] : []));
    const activeStaff = await this.roster.activeStaffRoles(staffIds);
    return rows.filter((r) =>
      r.student
        ? r.student.deletedAt !== null || r.student.status !== 'ACTIVE'
        : !activeStaff.has(r.staffUserId!),
    );
  }

  /** 404 unless the student is this institute's and not deleted. */
  private async studentKey(studentId: string): Promise<string> {
    const student = await this.db.tx.student.findFirst({
      where: { id: studentId, deletedAt: null },
      select: { id: true },
    });
    if (!student) throw new NotFoundException('Student not found');
    return personKey('STUDENT', student.id);
  }

  /** 422 NOT_STAFF unless the user has an active staff role and a staff profile here. */
  private async staffKey(userId: string): Promise<string> {
    const profile = await this.db.tx.staffProfile.findFirst({
      where: { userId },
      select: { userId: true },
    });
    const roles = await this.roster.activeStaffRoles([userId]);
    if (!profile || !roles.has(userId)) {
      throw apiError(422, 'NOT_STAFF', 'Not an active staff member here');
    }
    return personKey('STAFF', userId);
  }
}

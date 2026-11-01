import { Prisma, type TenantTx } from '@jantrik/db';
import { STAFF_ROLE_VALUES, deviceDisplayName, userUpsertPayload } from '@jantrik/shared';

/** A person as a device knows them: the ID and the USER_UPSERT that puts them on it. */
export interface DeviceUser {
  deviceUserId: string;
  payload: string;
}

/**
 * Everyone with a device ID who belongs on the devices (students ACTIVE and not deleted, staff
 * with an ACTIVE staff role), by ID, each with the name the device shows: the English name (a
 * staff member's profile name), else the student code or the ID. `deviceUserIds` limits it.
 */
export async function deviceUsers(tx: TenantTx, deviceUserIds?: string[]): Promise<DeviceUser[]> {
  const people = await tx.devicePerson.findMany({
    where: deviceUserIds ? { deviceUserId: { in: deviceUserIds } } : {},
    select: {
      deviceUserId: true,
      staffUserId: true,
      student: { select: { nameEn: true, studentCode: true, status: true, deletedAt: true } },
      staffProfile: { select: { name: true } },
    },
    orderBy: { deviceUserId: 'asc' },
  });
  const staffIds = people.flatMap((p) => (p.staffUserId ? [p.staffUserId] : []));
  const activeStaff = new Set(
    (
      await tx.membership.findMany({
        where: {
          userId: { in: staffIds },
          status: 'ACTIVE',
          role: { in: [...STAFF_ROLE_VALUES] },
        },
        select: { userId: true },
      })
    ).map((m) => m.userId),
  );
  const out: DeviceUser[] = [];
  for (const p of people) {
    let name: string;
    if (p.student) {
      if (p.student.status !== 'ACTIVE' || p.student.deletedAt !== null) continue;
      name = deviceDisplayName(p.student.nameEn, p.student.studentCode);
    } else if (p.staffUserId && p.staffProfile && activeStaff.has(p.staffUserId)) {
      name = deviceDisplayName(p.staffProfile.name, p.deviceUserId);
    } else continue;
    out.push({ deviceUserId: p.deviceUserId, payload: userUpsertPayload(p.deviceUserId, name) });
  }
  return out;
}

/**
 * Queue a USER_UPSERT for each user on each device, except where the last command waiting
 * (PENDING or SENT) there for that ID is this same upsert. A waiting removal queued after it does
 * not count as the user being on its way. Inserts only: no command row is locked.
 */
export async function queueUpserts(
  tx: TenantTx,
  input: { tenantId: string; deviceIds: string[]; users: DeviceUser[]; createdById: string },
): Promise<{ queued: number; skipped: number }> {
  if (input.deviceIds.length === 0 || input.users.length === 0) return { queued: 0, skipped: 0 };
  const lastWaiting = new Map<string, string>();
  for (const c of await tx.deviceCommand.findMany({
    where: {
      deviceId: { in: input.deviceIds },
      deviceUserId: { in: input.users.map((u) => u.deviceUserId) },
      status: { in: ['PENDING', 'SENT'] },
    },
    orderBy: { seq: 'asc' },
    select: { deviceId: true, deviceUserId: true, kind: true, payload: true },
  })) {
    lastWaiting.set(`${c.deviceId}:${c.deviceUserId}`, c.kind === 'USER_UPSERT' ? c.payload : '');
  }
  const queue: Prisma.DeviceCommandCreateManyInput[] = [];
  let skipped = 0;
  for (const deviceId of input.deviceIds) {
    for (const u of input.users) {
      if (lastWaiting.get(`${deviceId}:${u.deviceUserId}`) === u.payload) {
        skipped += 1;
        continue;
      }
      queue.push({
        tenantId: input.tenantId,
        deviceId,
        kind: 'USER_UPSERT',
        deviceUserId: u.deviceUserId,
        payload: u.payload,
        createdById: input.createdById,
      });
    }
  }
  if (queue.length > 0) await tx.deviceCommand.createMany({ data: queue });
  return { queued: queue.length, skipped };
}

/** The institute's active devices, oldest first. */
export async function activeDeviceIds(tx: TenantTx): Promise<string[]> {
  const rows = await tx.attendanceDevice.findMany({
    where: { isActive: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return rows.map((d) => d.id);
}

/** IDs an active device has someone under: the devices, the last add confirmed, a removal waiting. */
export interface IdOnDevices {
  deviceIds: string[];
  lastSyncAt: Date;
  removing: boolean;
}

/**
 * IDs (all, or these) whose last confirmed command on some active device was an add (USER_UPSERT
 * done), with those devices. A removal queued after it and not confirmed yet leaves the ID on the
 * device (`removing`).
 */
export async function idsOnDevices(
  tx: TenantTx,
  ids?: string[],
): Promise<Map<string, IdOnDevices>> {
  const only = ids ? Prisma.sql`AND c.device_user_id = ANY(${ids}::text[])` : Prisma.empty;
  const rows = await tx.$queryRaw<
    { device_user_id: string; device_ids: string[]; last_sync_at: Date; removing: boolean }[]
  >`
    WITH latest AS (
      SELECT DISTINCT ON (c.device_id, c.device_user_id)
             c.device_id, c.device_user_id, c.kind, c.seq,
             coalesce(c.done_at, c.updated_at) AS done_at
      FROM device_commands c
      JOIN attendance_devices d ON d.tenant_id = c.tenant_id AND d.id = c.device_id
      WHERE d.is_active AND c.status = 'DONE' ${only}
      ORDER BY c.device_id, c.device_user_id, c.seq DESC
    ), still AS (
      SELECT l.*, EXISTS (SELECT 1 FROM device_commands x
                          WHERE x.device_id = l.device_id
                            AND x.device_user_id = l.device_user_id
                            AND x.kind = 'USER_DELETE' AND x.status IN ('PENDING', 'SENT')
                            AND x.seq > l.seq) AS removing
      FROM latest l
      WHERE l.kind = 'USER_UPSERT'
    )
    SELECT device_user_id, array_agg(device_id::text ORDER BY device_id) AS device_ids,
           max(done_at) AS last_sync_at, bool_or(removing) AS removing
    FROM still
    GROUP BY device_user_id`;
  return new Map(
    rows.map((r) => [
      r.device_user_id,
      { deviceIds: r.device_ids, lastSyncAt: r.last_sync_at, removing: r.removing },
    ]),
  );
}

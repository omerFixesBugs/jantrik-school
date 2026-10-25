import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type AttendanceDevice, type DeviceSourceIp } from '@jantrik/db';
import {
  DEVICE_CLOCK_WARNING_SEC,
  deviceState,
  type DeviceAddress,
  type DeviceChanges,
  type DeviceCommandStatus,
  type DeviceCommandView,
  type DeviceList,
  type DeviceSyncResult,
  type DeviceView,
  type NewDevice,
  type TrustAddressResult,
} from '@jantrik/shared';
import type { Redis } from 'ioredis';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../common/request-context.js';
import type { Env } from '../config/env.js';
import { REDIS } from '../redis/redis.constants.js';
import { staffNames, staffRef } from '../staff/staff.module.js';
import { Db } from '../tenancy/db.service.js';
import { DeviceAttendanceService } from './device-attendance.service.js';
import { deviceUsers, queueUpserts } from './device-users.js';
import { DEVICES_TENANTS_KEY } from './devices.constants.js';

interface DeviceCounts {
  pending: number;
  failed: number;
  untrusted: number;
}
const NO_COUNTS: DeviceCounts = { pending: 0, failed: 0, untrusted: 0 };

const COMMANDS_SHOWN = 100;

/** The only unique index a device write can hit is the active serial number's. */
const isSerialTaken = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
// The same answer whoever holds it, here or in another institute.
const serialTaken = () =>
  apiError(409, 'SERIAL_TAKEN', "This serial number can't be added; contact Jantrik");

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Devices, their commands and their source addresses (OWNER/ADMIN). Everything runs in the request
 * transaction and is audited. Lock order, as the device receiver's: a device's row first, then
 * its commands or addresses.
 */
@Injectable()
export class DevicesService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly config: ConfigService<Env, true>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly deviceAttendance: DeviceAttendanceService,
  ) {}

  async list(): Promise<DeviceList> {
    const tx = this.db.tx;
    const devices = await tx.attendanceDevice.findMany({
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const commands = await tx.deviceCommand.groupBy({
      by: ['deviceId', 'status'],
      where: { status: { in: ['PENDING', 'SENT', 'FAILED'] } },
      _count: { _all: true },
    });
    const untrusted = await tx.deviceSourceIp.groupBy({
      by: ['deviceId'],
      where: { trustedAt: null },
      _count: { _all: true },
    });
    const counts = new Map<string, DeviceCounts>();
    const of = (id: string) => {
      const c = counts.get(id) ?? { ...NO_COUNTS };
      counts.set(id, c);
      return c;
    };
    for (const c of commands) {
      if (c.status === 'FAILED') of(c.deviceId).failed += c._count._all;
      else of(c.deviceId).pending += c._count._all;
    }
    for (const u of untrusted) of(u.deviceId).untrusted = u._count._all;
    const now = this.clock.now();
    return {
      devices: devices.map((d) => this.toView(d, counts.get(d.id) ?? NO_COUNTS, now)),
      setup: {
        host: this.config.get('INGEST_PUBLIC_HOST', { infer: true }),
        port: this.config.get('INGEST_PUBLIC_PORT', { infer: true }),
      },
    };
  }

  /** A serial number active anywhere is refused with SERIAL_TAKEN, never saying where. */
  async create(input: NewDevice): Promise<DeviceView> {
    const me = this.context.requirePrincipal();
    const tenantId = me.tenantId!;
    const now = this.clock.now();
    let row: AttendanceDevice;
    try {
      row = await this.db.tx.attendanceDevice.create({
        data: {
          tenantId,
          brand: input.brand,
          serialNo: input.serialNo,
          name: input.name,
          gate: input.gate,
          direction: input.direction,
          createdById: me.userId,
          updatedById: me.userId,
          createdAt: now,
          updatedAt: now,
        },
      });
    } catch (error) {
      if (isSerialTaken(error)) throw serialTaken();
      throw error;
    }
    await this.audit.record({
      entity: 'attendance_device',
      entityId: row.id,
      action: 'CREATE',
      newValues: {
        brand: row.brand,
        serialNo: row.serialNo,
        name: row.name,
        gate: row.gate,
        direction: row.direction,
        isActive: row.isActive,
      },
    });
    // The daily jobs visit only the institutes listed here.
    await this.context.afterCommit(() =>
      this.redis.zadd(DEVICES_TENANTS_KEY, now.getTime(), tenantId),
    );
    return this.toView(row, NO_COUNTS, now);
  }

  /**
   * Name, gate, direction, on/off and the serial number. The serial number of a device that has
   * ever connected is locked (its punches and addresses belong to that hardware).
   */
  async update(id: string, patch: DeviceChanges): Promise<DeviceView> {
    const before = await this.lockDevice(id);
    const next = {
      name: patch.name ?? before.name,
      gate: patch.gate === undefined ? before.gate : patch.gate,
      direction: patch.direction ?? before.direction,
      isActive: patch.isActive ?? before.isActive,
      serialNo: patch.serialNo ?? before.serialNo,
    };
    if (next.serialNo !== before.serialNo && before.lastSeenAt !== null) {
      throw apiError(
        409,
        'SERIAL_LOCKED',
        'A device that has connected keeps its serial number; add the new one as another device',
      );
    }
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
      (k) => next[k] !== before[k],
    );
    if (changed.length === 0) return this.view(before);
    let row: AttendanceDevice;
    try {
      row = await this.db.tx.attendanceDevice.update({
        where: { id },
        data: { ...next, updatedById: this.context.requirePrincipal().userId },
      });
    } catch (error) {
      if (isSerialTaken(error)) throw serialTaken();
      throw error;
    }
    await this.audit.record({
      entity: 'attendance_device',
      entityId: id,
      action: 'UPDATE',
      oldValues: Object.fromEntries(changed.map((k) => [k, before[k]])),
      newValues: Object.fromEntries(changed.map((k) => [k, next[k]])),
    });
    return this.view(row);
  }

  /**
   * Queue the name and ID of every active person with a device ID for this device (one
   * USER_UPSERT each), except those already waiting with the same payload.
   */
  async sync(id: string): Promise<DeviceSyncResult> {
    const tx = this.db.tx;
    const device = await this.lockDevice(id);
    if (!device.isActive) throw apiError(409, 'DEVICE_INACTIVE', 'This device is switched off');
    const { queued, skipped } = await queueUpserts(tx, {
      tenantId: device.tenantId,
      deviceIds: [id],
      users: await deviceUsers(tx),
      createdById: this.context.requirePrincipal().userId,
    });
    if (queued > 0) {
      // One row per sync, against the device; the counts only (the commands carry names).
      await this.audit.record({
        entity: 'device_command',
        entityId: id,
        action: 'CREATE',
        newValues: { kind: 'USER_UPSERT', queued, skipped },
      });
    }
    return { queued, skipped };
  }

  /** The latest commands (never their payload, which carries names). */
  async commands(id: string, status?: DeviceCommandStatus): Promise<DeviceCommandView[]> {
    await this.findDevice(id);
    const rows = await this.db.tx.deviceCommand.findMany({
      where: { deviceId: id, ...(status ? { status } : {}) },
      orderBy: { seq: 'desc' },
      take: COMMANDS_SHOWN,
      select: {
        seq: true,
        kind: true,
        deviceUserId: true,
        status: true,
        attempts: true,
        sentAt: true,
        doneAt: true,
        returnCode: true,
      },
    });
    return rows.map((c) => ({
      seq: c.seq.toString(),
      kind: c.kind,
      deviceUserId: c.deviceUserId,
      status: c.status,
      attempts: c.attempts,
      sentAt: iso(c.sentAt),
      doneAt: iso(c.doneAt),
      returnCode: c.returnCode,
    }));
  }

  /** The addresses the device called from, the latest first. */
  async addresses(id: string): Promise<DeviceAddress[]> {
    await this.findDevice(id);
    const rows = await this.db.tx.deviceSourceIp.findMany({
      where: { deviceId: id },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
    });
    return this.addressViews(rows);
  }

  /**
   * Trust an address: commands may go to it, and its punches stop being flagged. Its NEW_IP
   * punches nobody reviewed are marked OK by the same person at the same time.
   */
  async trust(id: string, ipId: string): Promise<TrustAddressResult> {
    const tx = this.db.tx;
    await this.lockDevice(id);
    // Punch rows change below: the institute's punch lock first, as processing and reviews take it.
    await this.deviceAttendance.lockPunches();
    const before = await this.findAddress(id, ipId);
    const me = this.context.requirePrincipal().userId;
    const now = this.clock.now();
    const row = await tx.deviceSourceIp.update({
      where: { id: ipId },
      data: { trustedAt: now, trustedById: me },
    });
    const reviewed = await tx.devicePunch.updateMany({
      where: { deviceId: id, sourceIp: before.ip, review: null, flags: { has: 'NEW_IP' } },
      data: { review: 'OK', reviewedById: me, reviewedAt: now },
    });
    await this.audit.record({
      entity: 'device_source_ip',
      entityId: ipId,
      action: 'UPDATE',
      oldValues: {
        ip: before.ip,
        trustedAt: iso(before.trustedAt),
        trustedById: before.trustedById,
      },
      newValues: {
        ip: row.ip,
        trustedAt: iso(row.trustedAt),
        trustedById: row.trustedById,
        reviewedPunches: reviewed.count,
      },
    });
    const [address] = await this.addressViews([row]);
    return { address: address!, reviewedPunches: reviewed.count };
  }

  /**
   * Stop trusting an address (one trusted automatically on first contact may have been someone
   * else's): it gets no commands, and its punches are flagged NEW_IP again.
   */
  async revoke(id: string, ipId: string): Promise<DeviceAddress> {
    await this.lockDevice(id);
    const before = await this.findAddress(id, ipId);
    const row = await this.db.tx.deviceSourceIp.update({
      where: { id: ipId },
      data: { trustedAt: null, trustedById: null },
    });
    await this.audit.record({
      entity: 'device_source_ip',
      entityId: ipId,
      action: 'UPDATE',
      oldValues: {
        ip: before.ip,
        trustedAt: iso(before.trustedAt),
        trustedById: before.trustedById,
      },
      newValues: { ip: row.ip, trustedAt: null, trustedById: null },
    });
    const [address] = await this.addressViews([row]);
    return address!;
  }

  /** The device (404 when it is not this institute's). */
  private async findDevice(id: string): Promise<AttendanceDevice> {
    const device = await this.db.tx.attendanceDevice.findUnique({ where: { id } });
    if (!device) throw new NotFoundException('Device not found');
    return device;
  }

  /**
   * The device row, locked until the request ends: the receiver locks it first too, so its
   * checks and this change see one another whole.
   */
  private async lockDevice(id: string): Promise<AttendanceDevice> {
    const locked = await this.db.tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM attendance_devices WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
    if (locked.length === 0) throw new NotFoundException('Device not found');
    return this.findDevice(id);
  }

  private async findAddress(deviceId: string, ipId: string): Promise<DeviceSourceIp> {
    const row = await this.db.tx.deviceSourceIp.findFirst({ where: { id: ipId, deviceId } });
    if (!row) throw new NotFoundException('Address not found');
    return row;
  }

  private async addressViews(rows: DeviceSourceIp[]): Promise<DeviceAddress[]> {
    const names = await staffNames(this.db.tx, [
      ...new Set(rows.flatMap((r) => (r.trustedById ? [r.trustedById] : []))),
    ]);
    return rows.map((r) => ({
      id: r.id,
      ip: r.ip,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      punchCount: r.punchCount,
      trusted: r.trustedAt !== null,
      trustedAt: iso(r.trustedAt),
      trustedBy:
        r.trustedAt === null ? null : r.trustedById ? staffRef(names, r.trustedById) : 'automatic',
    }));
  }

  /** One device with its counts. */
  private async view(device: AttendanceDevice): Promise<DeviceView> {
    const tx = this.db.tx;
    const commands = await tx.deviceCommand.groupBy({
      by: ['status'],
      where: { deviceId: device.id, status: { in: ['PENDING', 'SENT', 'FAILED'] } },
      _count: { _all: true },
    });
    const untrusted = await tx.deviceSourceIp.count({
      where: { deviceId: device.id, trustedAt: null },
    });
    const count = (failed: boolean) =>
      commands
        .filter((c) => (c.status === 'FAILED') === failed)
        .reduce((sum, c) => sum + c._count._all, 0);
    return this.toView(
      device,
      { pending: count(false), failed: count(true), untrusted },
      this.clock.now(),
    );
  }

  private toView(d: AttendanceDevice, counts: DeviceCounts, now: Date): DeviceView {
    return {
      id: d.id,
      brand: d.brand,
      serialNo: d.serialNo,
      name: d.name,
      gate: d.gate,
      direction: d.direction,
      isActive: d.isActive,
      state: deviceState(d.lastSeenAt, now, d.isActive),
      lastSeenAt: iso(d.lastSeenAt),
      lastPunchAt: iso(d.lastPunchAt),
      lastIp: d.lastIp,
      firmware: d.firmware,
      userCount: d.userCount,
      pushVersion: d.pushVersion,
      clockOffsetSec: d.clockOffsetSec,
      clockWarning:
        d.clockOffsetSec !== null && Math.abs(d.clockOffsetSec) >= DEVICE_CLOCK_WARNING_SEC,
      pendingCommands: counts.pending,
      failedCommands: counts.failed,
      lastFloodAt: iso(d.lastFloodAt),
      lastFloodDropped: d.lastFloodDropped,
      untrustedAddresses: counts.untrusted,
      createdAt: d.createdAt.toISOString(),
    };
  }
}

import { Injectable } from '@nestjs/common';
import {
  DEVICE_CLOCK_WARNING_SEC,
  deviceState,
  localDateOf,
  localTimeOf,
  type DeviceAlert,
} from '@jantrik/shared';
import {
  AttendanceSettingsService,
  timeFromDb,
} from '../attendance/attendance-settings.service.js';
import { Clock } from '../common/clock.js';
import { Db } from '../tenancy/db.service.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A device offline (or never connected) this long is an alert. */
const OFFLINE_ALERT_MS = 10 * MINUTE;
/** New addresses and held punches are looked for this far back. */
const RECENT_MS = 7 * DAY;
const FLOOD_RECENT_MS = DAY;

const seconds = (hhmm: string): number => {
  const [h = 0, m = 0, s = 0] = hhmm.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

/**
 * What needs an admin's eye on the devices screen and the dashboard, for active devices:
 * OFFLINE, NEW_IP, FLOOD, HELD and CLOCK, in that order.
 */
@Injectable()
export class DeviceAlertsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly settings: AttendanceSettingsService,
  ) {}

  async alerts(): Promise<DeviceAlert[]> {
    const tx = this.db.tx;
    const now = this.clock.now();
    const devices = await tx.attendanceDevice.findMany({
      where: { isActive: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        lastSeenAt: true,
        createdAt: true,
        clockOffsetSec: true,
        lastFloodAt: true,
        lastFloodDropped: true,
      },
    });
    if (devices.length === 0) return [];
    const ids = devices.map((d) => d.id);
    const named = (d: { id: string; name: string }) => ({ deviceId: d.id, deviceName: d.name });
    const alerts: DeviceAlert[] = [];

    if (await this.watchingForOffline(now)) {
      for (const d of devices) {
        const state = deviceState(d.lastSeenAt, now, true);
        const since = d.lastSeenAt ?? d.createdAt;
        if (state === 'ONLINE' || state === 'INACTIVE') continue;
        if (now.getTime() - since.getTime() <= OFFLINE_ALERT_MS) continue;
        alerts.push({ kind: 'OFFLINE', ...named(d), state, since: since.toISOString() });
      }
    }

    // Untrusted addresses that sent punches lately (only such punches keep their address).
    const recent = new Date(now.getTime() - RECENT_MS);
    const sources = await tx.devicePunch.findMany({
      where: { deviceId: { in: ids }, receivedAt: { gte: recent }, sourceIp: { not: null } },
      distinct: ['deviceId', 'sourceIp'],
      select: { deviceId: true, sourceIp: true },
    });
    const sending = new Set(sources.map((s) => `${s.deviceId} ${s.sourceIp}`));
    const untrusted = await tx.deviceSourceIp.findMany({
      where: { deviceId: { in: ids }, trustedAt: null },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
    });
    for (const d of devices) {
      for (const a of untrusted) {
        if (a.deviceId !== d.id || !sending.has(`${a.deviceId} ${a.ip}`)) continue;
        alerts.push({
          kind: 'NEW_IP',
          ...named(d),
          ipId: a.id,
          ip: a.ip,
          punchCount: a.punchCount,
          lastSeenAt: a.lastSeenAt.toISOString(),
        });
      }
    }

    for (const d of devices) {
      if (d.lastFloodAt && now.getTime() - d.lastFloodAt.getTime() <= FLOOD_RECENT_MS) {
        alerts.push({
          kind: 'FLOOD',
          ...named(d),
          at: d.lastFloodAt.toISOString(),
          dropped: d.lastFloodDropped ?? 0,
        });
      }
    }

    const held = await tx.devicePunch.groupBy({
      by: ['deviceId'],
      where: {
        deviceId: { in: ids },
        flags: { has: 'BURST' },
        review: null,
        receivedAt: { gte: recent },
      },
      _count: { _all: true },
    });
    for (const d of devices) {
      const count = held.find((h) => h.deviceId === d.id)?._count._all ?? 0;
      if (count > 0) alerts.push({ kind: 'HELD', ...named(d), count });
    }

    for (const d of devices) {
      const offset = d.clockOffsetSec;
      if (offset === null || Math.abs(offset) < DEVICE_CLOCK_WARNING_SEC) continue;
      alerts.push({
        kind: 'CLOCK',
        ...named(d),
        minutes: Math.round(Math.abs(offset) / 60),
        ahead: offset > 0,
      });
    }
    return alerts;
  }

  /**
   * Offline devices matter on working days, from an hour before the earliest start (any active
   * shift's, or "school starts at") until the office closes.
   */
  private async watchingForOffline(now: Date): Promise<boolean> {
    const tenant = await this.settings.load();
    const today = localDateOf(now, tenant.timezone);
    if ((await this.settings.nonWorkingDay(today, tenant.settings)) !== null) return false;
    const shifts = await this.db.tx.shift.findMany({
      where: { isActive: true },
      select: { startTime: true },
    });
    const earliest = Math.min(
      seconds(tenant.settings.deviceDefaultStart),
      ...shifts.map((s) => seconds(timeFromDb(s.startTime))),
    );
    const time = seconds(localTimeOf(now, tenant.timezone));
    return time >= earliest - 3600 && time <= seconds(tenant.settings.staffOfficeEnd);
  }
}

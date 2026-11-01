import type { Redis } from 'ioredis';

/** The queue the device receiver (src/ingest) feeds and the API's devices worker reads. */
export const DEVICES_QUEUE = 'devices';

/** Processes an institute's new punches. */
export const PROCESS_PUNCHES_JOB = 'process-punches';

/** Every minute (scheduler and job name): each institute's leftover punches, then its cutoff. */
export const DEVICES_TICK_JOB = 'devices-tick';

/** Daily (scheduler and job name): each institute's punches and commands past retention. */
export const EXPIRE_PUNCHES_JOB = 'expire-punches';

/** The whole job: the institute id comes from the database's answer, never from a device. */
export interface ProcessPunchesJob {
  tenantId: string;
}

/**
 * One waiting job per institute, so a burst of uploads is processed once. BullMQ refuses a ':' in
 * custom job ids, hence the dash.
 */
export const processPunchesJobId = (tenantId: string): string => `punches-${tenantId}`;

/**
 * Institutes with devices (ZSET, score = when last added), for the minute tick and the daily
 * retention: each is visited in its own TenantJobRunner transaction, never by a cross-tenant
 * query. Nothing else knows which institutes have devices, so every path that needs them visited
 * lists the institute again (`listDevicesTenant`): adding, changing or syncing a device, saving
 * the settings with auto-mark on, and each process-punches job. A lost set or a fresh seed heals
 * the same way.
 */
export const DEVICES_TENANTS_KEY = 'devices:tenants';

/** Lists the institute for the minute tick and retention (after its transaction committed). */
export const listDevicesTenant = (redis: Redis, tenantId: string, at: Date): Promise<number> =>
  redis.zadd(DEVICES_TENANTS_KEY, at.getTime(), tenantId);

/**
 * Flagged punches are reviewed within this long of arriving: the flagged feed and the NEW_IP and
 * HELD alerts look this far back.
 */
export const REVIEW_WINDOW_MS = 7 * 24 * 3600_000;

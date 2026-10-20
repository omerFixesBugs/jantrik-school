import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { SmsPurpose } from '@jantrik/db';
import { dateFromDb, dateToDb, smsLength, todayIn, type IsoDate } from '@jantrik/shared';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { RequestContext } from '../common/request-context.js';
import { REDIS } from '../redis/redis.constants.js';
import { Db } from '../tenancy/db.service.js';

export interface TenantSmsJob {
  /** Our own enqueued value: the job runner opens this tenant's RLS context. */
  tenantId: string;
  /** No phone numbers or text in Redis: the worker loads the sms_logs row. */
  smsLogId: string;
}

export interface QueueTenantSmsInput {
  purpose: SmsPurpose;
  phone: string;
  body: string;
  /** Tenant-local day the SMS belongs to (daily cap and billing). */
  localDate: IsoDate;
  /** At most one SMS per key per tenant, ever (e.g. "absent:<studentId>:<date>"). */
  dedupeKey: string;
  relatedEntity?: string;
  relatedId?: string;
  delayMs: number;
  /** Most SMS this tenant may send on `localDate`. */
  dailyCap: number;
}

export type QueueTenantSmsResult = 'QUEUED' | 'DUPLICATE' | 'HELD_OVER_LIMIT';

/** Decides, just before sending, whether an SMS is still wanted (e.g. the absence still stands). */
export type SmsRelevanceCheck = (log: {
  relatedEntity: string | null;
  relatedId: string | null;
  localDate: IsoDate;
}) => Promise<boolean>;

// Only these count against the daily cap.
const COUNTED: ('QUEUED' | 'SENT')[] = ['QUEUED', 'SENT'];

/**
 * Tenants with SMS held over the cap on a date (a Redis set of our own values). The daily job
 * visits just these tenants to expire what was not released, without a cross-tenant query.
 */
export const heldTenantsKey = (localDate: string) => `sms:held-tenants:${localDate}`;
const HELD_KEY_TTL_SEC = 3 * 86_400;

/** Job name (sms queue) of the daily expiry, scheduled at 00:05 Dhaka time. */
export const EXPIRE_HELD_JOB = 'expire-held';

/**
 * SMS sent on behalf of a tenant: every one is logged in sms_logs (we bill from it), deduplicated
 * by key, limited per day, and queued only after the request transaction commits.
 */
@Injectable()
export class TenantSmsService implements OnModuleInit {
  private readonly logger = new Logger(TenantSmsService.name);
  private readonly relevance = new Map<SmsPurpose, SmsRelevanceCheck>();

  constructor(
    @InjectQueue('sms') private readonly jobs: Queue<TenantSmsJob>,
    private readonly db: Db,
    private readonly context: RequestContext,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** One scheduler for all API instances (BullMQ upserts it by id). */
  async onModuleInit(): Promise<void> {
    await this.jobs.upsertJobScheduler(
      'expire-held-sms',
      { pattern: '5 0 * * *', tz: 'Asia/Dhaka' },
      { name: EXPIRE_HELD_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } },
    );
  }

  /** Modules register how to re-check their SMS before sending (runs in the tenant context). */
  registerRelevanceCheck(purpose: SmsPurpose, check: SmsRelevanceCheck): void {
    this.relevance.set(purpose, check);
  }

  /** Call inside a request transaction. Rolled back with it; queued only after commit. */
  async queue(input: QueueTenantSmsInput): Promise<QueueTenantSmsResult> {
    const tx = this.db.tx;
    // One SMS writer per tenant at a time, so the dedupe check and the daily count can't race.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('sms:' || app_current_tenant_id()::text, 0))`;

    const existing = await tx.smsLog.findFirst({
      where: { dedupeKey: input.dedupeKey },
      select: { id: true },
    });
    if (existing) return 'DUPLICATE';
    await this.expireHeld(input.localDate); // in case the daily job has not run yet

    const localDate = dateToDb(input.localDate);
    const used = await tx.smsLog.count({ where: { localDate, status: { in: COUNTED } } });
    const overLimit = used >= input.dailyCap;

    const tenantId = this.context.requirePrincipal().tenantId!;
    const log = await tx.smsLog.create({
      data: {
        tenantId,
        phone: input.phone,
        purpose: input.purpose,
        status: overLimit ? 'HELD_OVER_LIMIT' : 'QUEUED',
        segments: smsLength(input.body).segments,
        body: input.body,
        localDate,
        dedupeKey: input.dedupeKey,
        relatedEntity: input.relatedEntity ?? null,
        relatedId: input.relatedId ?? null,
        sendAfter: new Date(Date.now() + input.delayMs),
      },
      select: { id: true },
    });
    if (overLimit) {
      const key = heldTenantsKey(input.localDate);
      await this.context.afterCommit(() =>
        this.redis.multi().sadd(key, tenantId).expire(key, HELD_KEY_TTL_SEC).exec(),
      );
      return 'HELD_OVER_LIMIT';
    }
    await this.enqueue(tenantId, log.id, input.delayMs);
    return 'QUEUED';
  }

  /**
   * An admin sends today's held SMS anyway (over the institute's own cap). Each one is re-checked
   * first: when the reason went away (the student is no longer absent) it is CANCELLED instead.
   * `ceiling` is Jantrik's limit for the day (the plan): never passed, so only what still fits
   * under it is released, oldest first; the rest stay held. Call inside a request transaction;
   * the jobs are queued after commit.
   */
  async releaseHeld(
    localDate: IsoDate,
    ceiling: number | null = null,
  ): Promise<{ queued: string[]; cancelled: string[]; stillHeld: number }> {
    const tx = this.db.tx;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('sms:' || app_current_tenant_id()::text, 0))`;
    const day = dateToDb(localDate);
    const held = await tx.smsLog.findMany({
      where: { localDate: day, status: 'HELD_OVER_LIMIT' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, purpose: true, relatedEntity: true, relatedId: true },
    });
    // Counted under the same lock as queue(): nothing can slip in between.
    const room =
      ceiling === null
        ? Number.POSITIVE_INFINITY
        : Math.max(
            0,
            ceiling -
              (await tx.smsLog.count({ where: { localDate: day, status: { in: COUNTED } } })),
          );
    const tenantId = this.context.requirePrincipal().tenantId!;
    const queued: string[] = [];
    const cancelled: string[] = [];
    let stillHeld = 0;
    for (const log of held) {
      const check = this.relevance.get(log.purpose);
      const wanted =
        !check ||
        (await check({ relatedEntity: log.relatedEntity, relatedId: log.relatedId, localDate }));
      if (wanted && queued.length >= room) {
        stillHeld++;
        continue;
      }
      await tx.smsLog.update({
        where: { id: log.id },
        data: wanted
          ? { status: 'QUEUED', sendAfter: new Date() }
          : { status: 'CANCELLED', error: 'No longer relevant' },
      });
      if (wanted) {
        await this.enqueue(tenantId, log.id, 0);
        queued.push(log.id);
      } else {
        cancelled.push(log.id);
      }
    }
    return { queued, cancelled, stillHeld };
  }

  /** Held SMS of the days before `today` were never released: mark them EXPIRED. */
  async expireHeld(today: IsoDate): Promise<number> {
    const { count } = await this.db.tx.smsLog.updateMany({
      where: { status: 'HELD_OVER_LIMIT', localDate: { lt: dateToDb(today) } },
      data: { status: 'EXPIRED', error: 'Held over the daily limit; not sent that day' },
    });
    return count;
  }

  /** Job side (inside TenantJobRunner): expire this tenant's old held SMS. */
  async expireHeldForTenant(): Promise<{ today: IsoDate; expired: number }> {
    const tenant = await this.db.tx.tenant.findFirstOrThrow({ select: { timezone: true } });
    const today = todayIn(tenant.timezone);
    return { today, expired: await this.expireHeld(today) };
  }

  /** For the daily job: the tenants that had SMS held, per date. */
  async heldTenants(): Promise<{ key: string; date: IsoDate; tenantIds: string[] }[]> {
    const prefix = heldTenantsKey('');
    const out: { key: string; date: IsoDate; tenantIds: string[] }[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const tenantIds = await this.redis.smembers(key);
        out.push({ key, date: key.slice(prefix.length), tenantIds });
      }
    } while (cursor !== '0');
    return out;
  }

  async forgetHeldTenant(key: string, tenantId: string): Promise<void> {
    await this.redis.srem(key, tenantId);
  }

  private enqueue(tenantId: string, smsLogId: string, delayMs: number): Promise<void> {
    return this.context.afterCommit(async () => {
      await this.jobs.add(
        'tenant',
        { tenantId, smsLogId },
        {
          jobId: smsLogId, // a second guard against duplicates, at the queue level
          delay: delayMs,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    });
  }

  /** Queued or sent today vs. held back by the cap (dashboard warning). */
  async dailyCounts(
    localDate: IsoDate,
  ): Promise<{ used: number; held: number; heldSegments: number }> {
    const tx = this.db.tx;
    await this.expireHeld(localDate);
    const date = dateToDb(localDate);
    const used = await tx.smsLog.count({ where: { localDate: date, status: { in: COUNTED } } });
    const held = await tx.smsLog.aggregate({
      where: { localDate: date, status: 'HELD_OVER_LIMIT' },
      _count: true,
      _sum: { segments: true },
    });
    return { used, held: held._count, heldSegments: held._sum.segments ?? 0 };
  }

  // ── Worker side (inside TenantJobRunner) ──

  /** The phone and text to send now, or null when the SMS is no longer wanted (marked CANCELLED). */
  async prepare(smsLogId: string): Promise<{ phone: string; body: string } | null> {
    const tx = this.db.tx;
    const log = await tx.smsLog.findUnique({ where: { id: smsLogId } });
    if (!log || log.status !== 'QUEUED') return null; // already handled

    const tenant = await tx.tenant.findFirst({ select: { status: true } });
    const active = tenant && (tenant.status === 'ACTIVE' || tenant.status === 'TRIAL');
    const check = this.relevance.get(log.purpose);
    const stillWanted =
      active &&
      (!check ||
        (await check({
          relatedEntity: log.relatedEntity,
          relatedId: log.relatedId,
          localDate: dateFromDb(log.localDate),
        })));
    if (!stillWanted) {
      await tx.smsLog.update({
        where: { id: smsLogId },
        data: { status: 'CANCELLED', error: active ? 'No longer relevant' : 'Tenant not active' },
      });
      return null;
    }
    return { phone: log.phone, body: log.body };
  }

  /** Sent: the cost is segments × the platform's rate now (later rate changes keep it). */
  async markSent(smsLogId: string): Promise<void> {
    await this.db.tx.$executeRaw`
      UPDATE sms_logs
      SET status = 'SENT', sent_at = now(), updated_at = now(),
          -- platform_settings has exactly one row (the app may read only the rate column).
          cost_paisa = segments * (SELECT sms_cost_per_segment_paisa FROM platform_settings)
      WHERE id = ${smsLogId}::uuid AND status = 'QUEUED'`;
  }

  async markFailed(smsLogId: string, error: string): Promise<void> {
    this.logger.warn(`tenant SMS ${smsLogId} failed for good`);
    await this.db.tx.smsLog.updateMany({
      where: { id: smsLogId, status: 'QUEUED' },
      data: { status: 'FAILED', error: error.slice(0, 500) },
    });
  }
}

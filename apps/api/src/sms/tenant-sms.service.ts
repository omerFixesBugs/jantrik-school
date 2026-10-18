import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { SmsPurpose } from '@jantrik/db';
import { dateFromDb, dateToDb, smsLength, type IsoDate } from '@jantrik/shared';
import type { Queue } from 'bullmq';
import { RequestContext } from '../common/request-context.js';
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
 * SMS sent on behalf of a tenant: every one is logged in sms_logs (we bill from it), deduplicated
 * by key, limited per day, and queued only after the request transaction commits.
 */
@Injectable()
export class TenantSmsService {
  private readonly logger = new Logger(TenantSmsService.name);
  private readonly relevance = new Map<SmsPurpose, SmsRelevanceCheck>();

  constructor(
    @InjectQueue('sms') private readonly jobs: Queue<TenantSmsJob>,
    private readonly db: Db,
    private readonly context: RequestContext,
  ) {}

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
    if (overLimit) return 'HELD_OVER_LIMIT';

    await this.context.afterCommit(() =>
      this.jobs.add(
        'tenant',
        { tenantId, smsLogId: log.id },
        {
          jobId: log.id, // a second guard against duplicates, at the queue level
          delay: input.delayMs,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      ),
    );
    return 'QUEUED';
  }

  /** Queued or sent today vs. held back by the cap (dashboard warning). */
  async dailyCounts(localDate: IsoDate): Promise<{ used: number; held: number }> {
    const tx = this.db.tx;
    const date = dateToDb(localDate);
    const [used, held] = [
      await tx.smsLog.count({ where: { localDate: date, status: { in: COUNTED } } }),
      await tx.smsLog.count({ where: { localDate: date, status: 'HELD_OVER_LIMIT' } }),
    ];
    return { used, held };
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

  async markSent(smsLogId: string): Promise<void> {
    await this.db.tx.smsLog.updateMany({
      where: { id: smsLogId, status: 'QUEUED' },
      data: { status: 'SENT', sentAt: new Date() },
    });
  }

  async markFailed(smsLogId: string, error: string): Promise<void> {
    this.logger.warn(`tenant SMS ${smsLogId} failed for good`);
    await this.db.tx.smsLog.updateMany({
      where: { id: smsLogId, status: 'QUEUED' },
      data: { status: 'FAILED', error: error.slice(0, 500) },
    });
  }
}

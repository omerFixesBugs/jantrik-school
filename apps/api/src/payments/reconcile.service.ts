import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  isGatewayRef,
  type PaymentIntentStatus,
  type SslcommerzCredentials,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { AuditService } from '../audit/audit.module.js';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../common/request-context.js';
import { lockPaymentIntent, lockStudentFees, lockTenantFees } from '../fees/fee-locks.js';
import { RateLimiter } from '../redis/rate-limiter.service.js';
import { REDIS } from '../redis/redis.constants.js';
import { Db } from '../tenancy/db.service.js';
import { TenantJobRunner } from '../tenancy/tenant-job-runner.service.js';
import { ConfirmService, PaymentJobError } from './confirm.service.js';
import {
  PaymentCredentialsError,
  PaymentCredentialsService,
} from './payment-credentials.service.js';
import { PaymentEventsService } from './payment-events.service.js';
import {
  PAYMENTS_OPEN_KEY,
  PAYMENTS_QUEUE,
  PAYMENTS_SWEEP_JOB,
  RECONCILE_DELAYS_MS,
  RECONCILE_JOB,
  RECONCILE_JOB_OPTS,
  reconcileJobId,
  type ReconcileJobData,
  type ReconcileStep,
} from './payments.constants.js';
import {
  PAYMENT_PROVIDER,
  type AttemptStatus,
  type PaymentProvider,
  type ProviderErrorCode,
} from './provider.js';

const ENTITY = 'payment_intent';
const OPEN: readonly PaymentIntentStatus[] = ['CREATED', 'REDIRECTED'];
/** Settled for good: only the +25 h query (a second payment) and "check now" still ask. */
const FINAL: readonly PaymentIntentStatus[] = ['PAID', 'REFUNDED_OUTSIDE', 'DISMISSED'];
const SUCCESS: readonly AttemptStatus[] = ['VALID', 'VALIDATED'];
/** Attempts that are over with nothing paid (an undocumented status is never taken as one). */
const ENDED: readonly AttemptStatus[] = ['FAILED', 'CANCELLED', 'EXPIRED', 'UNATTEMPTED'];
/** New validation IDs validated per step at most; the next step takes the rest. */
const MAX_VALIDATIONS = 5;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The sweep runs every 10 minutes and re-adds steps overdue by more than 2 minutes. */
const SWEEP_EVERY_MS = 10 * MINUTE;
const SWEEP_GRACE_MS = 2 * MINUTE;
/** A step listed longer ago than this is dropped (step 5 is due at +7 days). */
const SWEEP_MAX_AGE_MS = 8 * 24 * HOUR;
/** The nightly run lists again an open intent older than this… */
const REQUEUE_OPEN_AFTER_MS = HOUR;
/** …and a posted one younger than this (its +25 h query, P7b-J). */
const REQUEUE_PAID_WITHIN_MS = 26 * HOUR;
/** Heal on read (the review page): a step overdue by more than this, once a minute per institute. */
const HEAL_OVERDUE_MS = 10 * MINUTE;
/** At most this many intents of one kind per institute per nightly run or heal. */
const BATCH = 500;

/** A step that could not ask the gateway for a reason of ours (credentials unreadable). */
export class ReconcileJobError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ReconcileJobError';
  }
}

/** What the last query found (payment_intents.last_check_outcome). */
export type CheckOutcome = 'SUCCESS_FOUND' | 'PENDING' | 'NO_SUCCESS' | string;

const member = (data: ReconcileJobData) => `${data.tenantId}:${data.intentId}:${data.step}`;

/**
 * Queueing reconciliation steps (sprint 1 P7b, docs/payments.md → Reconciliation): each step is
 * listed in the Redis sorted set `payments:open` (scored by when it is due) before its delayed job
 * is added, so a job Redis lost is found again by the sweep; a step's member is removed only when
 * the step is done. Job data carries ids only.
 */
@Injectable()
export class ReconcileQueue {
  constructor(
    @InjectQueue(PAYMENTS_QUEUE) private readonly queue: Queue,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly clock: Clock,
  ) {}

  /** A new session (REDIRECTED): steps 1 to 4, at +5 min, +30 min, +2 h, +25 h after creation. */
  async scheduleSession(tenantId: string, intentId: string, createdAt: Date): Promise<void> {
    for (const step of [1, 2, 3, 4] as const) {
      await this.queueStep({ tenantId, intentId, step }, this.dueAt(createdAt, step));
    }
  }

  /** When a scheduled step is due. */
  dueAt(createdAt: Date, step: Exclude<ReconcileStep, 'manual'>): number {
    return createdAt.getTime() + RECONCILE_DELAYS_MS[step - 1]!;
  }

  /** One step at `dueAt` (ms; at once when it has passed). A job that exists already is kept. */
  async queueStep(data: ReconcileJobData, dueAt: number): Promise<void> {
    if (data.step !== 'manual') await this.redis.zadd(PAYMENTS_OPEN_KEY, dueAt, member(data));
    await this.queue.add(RECONCILE_JOB, data, {
      jobId: reconcileJobId(data.intentId, data.step),
      delay: Math.max(0, dueAt - this.clock.now().getTime()),
      ...RECONCILE_JOB_OPTS,
    });
  }

  /** The step is done: no longer swept. */
  async done(data: ReconcileJobData): Promise<void> {
    if (data.step !== 'manual') await this.redis.zrem(PAYMENTS_OPEN_KEY, member(data));
  }

  /** The listed steps due at or before `before` (ms), with when each was due. */
  async listedBefore(before: number): Promise<{ listed: string; dueAt: number }[]> {
    const flat = await this.redis.zrangebyscore(PAYMENTS_OPEN_KEY, '-inf', before, 'WITHSCORES');
    const rows: { listed: string; dueAt: number }[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      rows.push({ listed: flat[i]!, dueAt: Number(flat[i + 1]) });
    }
    return rows;
  }

  async forget(listed: string): Promise<void> {
    await this.redis.zrem(PAYMENTS_OPEN_KEY, listed);
  }

  /** One sweep every 10 minutes for all API instances (BullMQ upserts it by id). */
  async scheduleSweep(): Promise<void> {
    await this.queue.upsertJobScheduler(
      PAYMENTS_SWEEP_JOB,
      { every: SWEEP_EVERY_MS },
      { name: PAYMENTS_SWEEP_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } },
    );
  }
}

/** A listed step (`<tenantId>:<intentId>:<step>`), or null for anything else. */
export function parseListed(listed: string): ReconcileJobData | null {
  const m = /^([0-9a-f-]{36}):([0-9a-f-]{36}):([1-5])$/.exec(listed);
  return m ? { tenantId: m[1]!, intentId: m[2]!, step: Number(m[3]) as 1 | 2 | 3 | 4 | 5 } : null;
}

/**
 * Reconciliation (sprint 1 P7b, docs/payments.md → Reconciliation): SSLCommerz is asked about
 * every online payment by our tran_id on a fixed schedule, so a lost IPN and a closed browser tab
 * still end in a receipt or in review. A query answer never posts by itself (P7b-A): every
 * successful attempt it lists whose validation ID has not been decided yet goes through the
 * validation API and settle (ConfirmService.validate), exactly as an IPN does. It never moves an
 * intent out of review (S23): settle only records what it finds there. No call is made inside a
 * transaction.
 *
 * - Steps 1–3 (and "check now"): an open intent past its hour whose attempts all ended with
 *   nothing paid is FAILED (CANCELLED when each was cancelled); PENDING changes nothing.
 * - Step 4 (+25 h, every intent: a second payment or a success after a close, P7b-J): an intent
 *   still open is EXPIRED, PENDING included; one still PENDING is asked once more at +7 days
 *   (step 5, P7b-K). A success found later goes to review as LATE_SUCCESS (settle).
 * - A gateway error fails the step with a fixed code (3 attempts, then the sweep).
 */
@Injectable()
export class ReconcileService implements OnModuleInit {
  private readonly logger = new Logger(ReconcileService.name);

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly jobs: TenantJobRunner,
    private readonly credentials: PaymentCredentialsService,
    private readonly events: PaymentEventsService,
    private readonly confirm: ConfirmService,
    private readonly queues: ReconcileQueue,
    private readonly context: RequestContext,
    private readonly limiter: RateLimiter,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /** One step of one intent (the `reconcile` job). */
  async run(data: ReconcileJobData): Promise<void> {
    const read = await this.jobs.run(data.tenantId, async () => {
      const tx = this.db.tx;
      const intent = await tx.paymentIntent.findUnique({
        where: { id: data.intentId },
        select: {
          id: true,
          tranId: true,
          status: true,
          payerUserId: true,
          accountId: true,
          createdAt: true,
          expiresAt: true,
        },
      });
      if (!intent) return null;
      if (FINAL.includes(intent.status) && data.step !== 4 && data.step !== 'manual') {
        return { intent, skip: true as const };
      }
      const decided = await tx.paymentGatewayEvent.findMany({
        where: {
          intentId: intent.id,
          kind: 'VALIDATE',
          outcome: { in: ['VALID', 'VALIDATED'] },
          valId: { not: null },
        },
        select: { valId: true },
      });
      let creds: SslcommerzCredentials | null = null;
      let credsFailure: string | null = null;
      try {
        creds = await this.credentials.read(intent.accountId);
      } catch (error) {
        if (!(error instanceof PaymentCredentialsError)) throw error;
        credsFailure = error.code;
        await this.recordAccountFailure(intent.accountId, error.code);
        await this.recordCheck(intent.id, error.code);
      }
      return {
        intent,
        skip: false as const,
        decided: new Set(decided.map((d) => d.valId!)),
        creds,
        credsFailure,
      };
    });
    if (!read || read.skip) {
      await this.queues.done(data);
      return;
    }
    const { intent, decided } = read;
    if (!read.creds) throw new ReconcileJobError(read.credsFailure ?? 'CREDENTIALS_MISSING');
    const creds = read.creds;

    // Outside any transaction: every attempt SSLCommerz knows for our tran_id.
    const attempts = await this.provider.query(creds, intent.tranId);
    const found = Array.isArray(attempts) ? attempts : [];
    const outcome: CheckOutcome = !Array.isArray(attempts)
      ? attempts.code
      : found.some((a) => SUCCESS.includes(a.status))
        ? 'SUCCESS_FOUND'
        : found.some((a) => a.status === 'PENDING')
          ? 'PENDING'
          : 'NO_SUCCESS';
    await this.jobs.run(data.tenantId, async () => {
      const statuses = [...new Set(found.map((a) => a.status))];
      await this.events.record({
        intentId: intent.id,
        kind: 'QUERY',
        outcome: !Array.isArray(attempts)
          ? attempts.code
          : statuses.length > 0
            ? statuses.join(',').slice(0, 40)
            : 'NONE',
        tranId: intent.tranId,
      });
      await this.recordCheck(intent.id, outcome);
      if (!Array.isArray(attempts))
        await this.recordAccountFailure(intent.accountId, attempts.code);
    });
    if (!Array.isArray(attempts)) throw new PaymentJobError(attempts.code);

    // Each success not decided yet: the validation API, then settle (one decision path).
    const fresh = [
      ...new Set(
        found
          .filter((a) => SUCCESS.includes(a.status) && isGatewayRef(a.valId))
          .map((a) => a.valId!),
      ),
    ]
      .filter((valId) => !decided.has(valId))
      .slice(0, MAX_VALIDATIONS);
    let failure: ProviderErrorCode | null = null;
    for (const valId of fresh) {
      failure = (await this.confirm.validate(data.tenantId, intent, creds, valId)) ?? failure;
    }
    if (failure) {
      const code = failure;
      await this.jobs.run(data.tenantId, () => this.recordAccountFailure(intent.accountId, code));
      throw new PaymentJobError(code);
    }

    if (outcome !== 'SUCCESS_FOUND') {
      const pending = outcome === 'PENDING';
      if (data.step === 4) {
        await this.close(data, 'EXPIRED');
        if (pending) {
          // Once more at +7 days, so a late bKash completion lands in review (P7b-K).
          await this.queues.queueStep(
            { tenantId: data.tenantId, intentId: intent.id, step: 5 },
            this.queues.dueAt(intent.createdAt, 5),
          );
        }
      } else if (
        data.step !== 5 &&
        !pending &&
        found.length > 0 &&
        found.every((a) => ENDED.includes(a.status)) &&
        this.clock.now() > intent.expiresAt
      ) {
        // The payer had the whole hour to try again; every attempt ended with nothing paid.
        await this.close(
          data,
          found.every((a) => a.status === 'CANCELLED') ? 'CANCELLED' : 'FAILED',
        );
      }
    }
    await this.queues.done(data);
  }

  /** One sweep of the payments queue for all API instances, every 10 minutes. */
  async onModuleInit(): Promise<void> {
    await this.queues.scheduleSweep();
  }

  /**
   * The `payments-sweep` job (P7b-B): every listed step overdue by more than 2 minutes is added
   * again with its own job id (nothing while that job exists); a step listed more than 8 days ago
   * is dropped. It reads Redis only: no institute's data, no query across institutes.
   */
  async sweep(): Promise<void> {
    const now = this.clock.now().getTime();
    for (const { listed, dueAt } of await this.queues.listedBefore(now - SWEEP_GRACE_MS)) {
      const data = parseListed(listed);
      if (!data || dueAt < now - SWEEP_MAX_AGE_MS) {
        await this.queues.forget(listed);
        continue;
      }
      await this.queues.queueStep(data, dueAt);
    }
  }

  /**
   * The nightly fee run's visit (P7b-B, FeeOnlineHooks.nightly), in this institute's own context:
   * after a Redis loss, its open payments older than an hour get their latest due step now and the
   * later ones at their times; a payment posted in the last 26 hours whose +25 h query has not run
   * gets it; an expired one still PENDING at +25 h gets its +7 day query. Job ids make it a no-op
   * for steps whose jobs still exist.
   */
  async requeueTenant(tenantId: string): Promise<void> {
    const now = this.clock.now();
    const rows = await this.jobs.run(tenantId, async () => {
      const tx = this.db.tx;
      const select = { id: true, createdAt: true, lastCheckedAt: true } as const;
      const [open, paid, pending] = await Promise.all([
        tx.paymentIntent.findMany({
          where: {
            status: { in: [...OPEN] },
            createdAt: { lt: new Date(now.getTime() - REQUEUE_OPEN_AFTER_MS) },
          },
          orderBy: { createdAt: 'asc' },
          take: BATCH,
          select,
        }),
        tx.paymentIntent.findMany({
          where: {
            status: 'PAID',
            createdAt: { gte: new Date(now.getTime() - REQUEUE_PAID_WITHIN_MS) },
          },
          take: BATCH,
          select,
        }),
        tx.paymentIntent.findMany({
          where: {
            status: 'EXPIRED',
            lastCheckOutcome: 'PENDING',
            createdAt: { gte: new Date(now.getTime() - SWEEP_MAX_AGE_MS) },
          },
          take: BATCH,
          select,
        }),
      ]);
      return { open, paid, pending };
    });
    for (const intent of rows.open) {
      const due = ([1, 2, 3, 4] as const).filter(
        (n) => this.queues.dueAt(intent.createdAt, n) <= now.getTime(),
      );
      const latest = due.at(-1);
      // Its latest due step already ran (its last check is newer): only later steps are missing.
      const ran =
        latest !== undefined &&
        intent.lastCheckedAt !== null &&
        intent.lastCheckedAt.getTime() >= this.queues.dueAt(intent.createdAt, latest);
      for (const n of [1, 2, 3, 4] as const) {
        // Of the steps already due only the latest runs (each asks the same question).
        if (due.includes(n) && (n !== latest || ran)) continue;
        await this.queues.queueStep(
          { tenantId, intentId: intent.id, step: n },
          this.queues.dueAt(intent.createdAt, n),
        );
      }
    }
    for (const [list, n] of [
      [rows.paid, 4],
      [rows.pending, 5],
    ] as const) {
      for (const intent of list) {
        const dueAt = this.queues.dueAt(intent.createdAt, n);
        if (intent.lastCheckedAt && intent.lastCheckedAt.getTime() >= dueAt) continue;
        await this.queues.queueStep({ tenantId, intentId: intent.id, step: n }, dueAt);
      }
    }
  }

  /**
   * Heal on read (the review page): an open payment of this institute whose latest due step is
   * more than 10 minutes overdue and has not run (its last check is older) is asked about now,
   * at most once a minute per institute. In the caller's transaction; queued after commit.
   */
  async healOverdue(): Promise<void> {
    const tenantId = this.context.requireTenantId();
    const now = this.clock.now().getTime();
    const open = await this.db.tx.paymentIntent.findMany({
      where: {
        status: { in: [...OPEN] },
        createdAt: { lt: new Date(now - RECONCILE_DELAYS_MS[0] - HEAL_OVERDUE_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
      select: { id: true, createdAt: true, lastCheckedAt: true },
    });
    const overdue = open.flatMap((intent) => {
      const n = ([4, 3, 2, 1] as const).find(
        (k) => this.queues.dueAt(intent.createdAt, k) <= now - HEAL_OVERDUE_MS,
      );
      if (!n) return [];
      const dueAt = this.queues.dueAt(intent.createdAt, n);
      if (intent.lastCheckedAt && intent.lastCheckedAt.getTime() >= dueAt) return [];
      const data: ReconcileJobData = { tenantId, intentId: intent.id, step: n };
      return [{ data, dueAt }];
    });
    if (overdue.length === 0) return;
    const allowed = await this.limiter.tryConsume({
      key: `pay-review-heal:${tenantId}`,
      limit: 1,
      windowSec: 60,
    });
    if (!allowed) return;
    await this.context.afterCommit(async () => {
      for (const { data, dueAt } of overdue) {
        await this.queues
          .queueStep(data, dueAt)
          .catch((error: unknown) =>
            this.logger.warn(`Could not queue a heal: ${(error as Error).name}`),
          );
      }
    });
  }

  /** The intent's last query by tran_id (no actor: not a decision; the QUERY event is the record). */
  private async recordCheck(intentId: string, outcome: CheckOutcome): Promise<void> {
    await this.db.tx.paymentIntent.update({
      where: { id: intentId },
      data: { lastCheckedAt: this.clock.now(), lastCheckOutcome: outcome },
      select: { id: true },
    });
  }

  /** The account's last failure, shown to the owner (a fixed code). */
  private async recordAccountFailure(accountId: string, code: string): Promise<void> {
    await this.db.tx.paymentGatewayAccount.update({
      where: { id: accountId },
      data: { lastFailureCode: code, lastFailureAt: this.clock.now() },
      select: { id: true },
    });
  }

  /**
   * Close an open intent with nothing paid (FAILED, CANCELLED, or EXPIRED at +25 h), under the
   * student's lock and the intent's row lock, audited with no person (the schedule did it).
   */
  private close(data: ReconcileJobData, to: 'FAILED' | 'CANCELLED' | 'EXPIRED'): Promise<boolean> {
    return this.jobs.run(data.tenantId, async () => {
      const tx = this.db.tx;
      const head = await tx.paymentIntent.findUnique({
        where: { id: data.intentId },
        select: { studentId: true },
      });
      if (!head) return false;
      await lockTenantFees(tx, 'shared');
      await lockStudentFees(tx, head.studentId);
      await lockPaymentIntent(tx, data.intentId);
      const intent = await tx.paymentIntent.findUniqueOrThrow({
        where: { id: data.intentId },
        select: { status: true },
      });
      if (!OPEN.includes(intent.status)) return false;
      await tx.paymentIntent.update({
        where: { id: data.intentId },
        data: { status: to, closedAt: this.clock.now() },
        select: { id: true },
      });
      await this.audit.record({
        entity: ENTITY,
        entityId: data.intentId,
        action: 'UPDATE',
        oldValues: { status: intent.status },
        newValues: { status: to, by: 'RECONCILE', step: data.step },
      });
      return true;
    });
  }
}

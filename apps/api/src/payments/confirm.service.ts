import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { isGatewayRef, type SslcommerzCredentials } from '@jantrik/shared';
import type { Queue } from 'bullmq';
import { Clock } from '../common/clock.js';
import { RateLimiter } from '../redis/rate-limiter.service.js';
import { Db } from '../tenancy/db.service.js';
import { TenantJobRunner } from '../tenancy/tenant-job-runner.service.js';
import {
  PaymentCredentialsError,
  PaymentCredentialsService,
} from './payment-credentials.service.js';
import { PaymentEventsService } from './payment-events.service.js';
import { queueConfirm } from './confirm-queue.js';
import { PAYMENTS_QUEUE, type IntentJobData, type UnmatchedJobData } from './payments.constants.js';
import {
  PAYMENT_PROVIDER,
  PROVIDER_ERROR_CODES,
  type PaymentProvider,
  type ProviderErrorCode,
} from './provider.js';
import { SettleService } from './settle.service.js';

/** Unmatched IPNs checked with the gateway per institute and hour. */
const UNMATCHED_PER_HOUR = 30;
/** Rounds of one confirm job: signals that arrive while it runs are taken in the next one. */
const MAX_ROUNDS = 3;

/** A confirm job that could not reach the gateway: retried by BullMQ (a fixed code only). */
export class PaymentJobError extends Error {
  constructor(readonly code: ProviderErrorCode) {
    super(code);
    this.name = 'PaymentJobError';
  }
}

const isErrorCode = (outcome: string | null): boolean =>
  outcome !== null && (PROVIDER_ERROR_CODES as readonly string[]).includes(outcome);

/**
 * A validation answer that settles a val_id for good. Not an error (the call is retried), and not
 * PENDING: a pending payment may still complete, so it is validated again (P7a2-x27).
 */
const isFinalAnswer = (outcome: string | null): boolean =>
  outcome !== null && outcome !== 'PENDING' && !isErrorCode(outcome);

interface IntentFacts {
  id: string;
  tranId: string;
  status: string;
  payerUserId: string;
  accountId: string;
}

/**
 * The `confirm` job (sprint 1 P7a2, docs/payments.md → Confirmation): nothing in a signal is
 * trusted. For every validation ID a return or IPN carried that has not been validated yet, ask
 * SSLCommerz's validation API with the institute's own credentials, outside any transaction, and
 * settle each answer. With none to validate (a failed or cancelled return, an IPN without one, a
 * heal), ask the transaction query API by our tran_id; every successful attempt it lists is then
 * validated the same way (nothing posts from a query answer alone). A gateway error makes the job
 * fail with a fixed code so BullMQ retries it (6 attempts from 30 s); the intent stays as it is.
 */
@Injectable()
export class ConfirmService {
  private readonly logger = new Logger(ConfirmService.name);

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly jobs: TenantJobRunner,
    private readonly credentials: PaymentCredentialsService,
    private readonly events: PaymentEventsService,
    private readonly settle: SettleService,
    private readonly limiter: RateLimiter,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @InjectQueue(PAYMENTS_QUEUE) private readonly queue: Queue,
  ) {}

  /** Read the intent, its signals and validations, and its credentials (one short transaction). */
  private read(data: IntentJobData) {
    return this.jobs.run(data.tenantId, async () => {
      const tx = this.db.tx;
      const intent = await tx.paymentIntent.findUnique({
        where: { id: data.intentId },
        select: { id: true, tranId: true, status: true, payerUserId: true, accountId: true },
      });
      if (!intent) return null;
      const events = await tx.paymentGatewayEvent.findMany({
        where: { intentId: intent.id },
        orderBy: { receivedAt: 'asc' },
        select: { kind: true, outcome: true, valId: true, fields: true, receivedAt: true },
      });
      let creds: SslcommerzCredentials | null = null;
      try {
        creds = await this.credentials.read(intent.accountId);
      } catch (error) {
        if (!(error instanceof PaymentCredentialsError)) throw error;
        await this.recordFailure(intent.accountId, error.code);
      }
      return { intent, events, creds };
    });
  }

  /** The account's last failure, shown to the owner (a fixed code). */
  private async recordFailure(accountId: string, code: string): Promise<void> {
    await this.db.tx.paymentGatewayAccount.update({
      where: { id: accountId },
      data: { lastFailureCode: code, lastFailureAt: this.clock.now() },
      select: { id: true },
    });
  }

  async run(data: IntentJobData): Promise<void> {
    const tried = new Set<string>();
    let failure: ProviderErrorCode | null = null;
    let validatedAny = false;
    for (let round = 0; ; round++) {
      const read = await this.read(data);
      if (!read?.creds) return;
      const { intent, events, creds } = read;
      const validated = new Set(
        events
          .filter((e) => e.kind === 'VALIDATE' && e.valId && isFinalAnswer(e.outcome))
          .map((e) => e.valId!),
      );
      const signals = events.filter((e) => e.kind === 'RETURN' || e.kind === 'IPN');
      const pending = [
        ...new Set(signals.map((e) => e.valId).filter((v): v is string => !!v)),
      ].filter((v) => !validated.has(v) && !tried.has(v));

      // Signals that arrived while this job ran are taken in the next round.
      if (pending.length > 0 && round < MAX_ROUNDS) {
        validatedAny = true;
        for (const valId of pending) {
          tried.add(valId);
          failure = (await this.validate(data.tenantId, intent, creds, valId)) ?? failure;
        }
        continue;
      }

      // Nothing (more) to validate. Ask the gateway by our tran_id while the intent is still open
      // (a failed or cancelled return, a made-up val_id, a heal), or when a signal without a
      // val_id came after the last query (a late payment). Once per job.
      const open = intent.status === 'CREATED' || intent.status === 'REDIRECTED';
      const lastQuery = events.filter((e) => e.kind === 'QUERY').at(-1)?.receivedAt ?? null;
      const lastBare = signals.filter((e) => !e.valId).at(-1)?.receivedAt ?? null;
      const newSignal =
        !validatedAny && lastBare !== null && (lastQuery === null || lastBare > lastQuery);
      if (failure === null && (open || newSignal)) {
        failure = await this.query(data.tenantId, intent, creds, signals, validated, tried);
      }
      break;
    }
    if (failure) {
      const code = failure;
      await this.jobs.run(data.tenantId, async () => {
        const intent = await this.db.tx.paymentIntent.findUnique({
          where: { id: data.intentId },
          select: { accountId: true },
        });
        if (intent) await this.recordFailure(intent.accountId, code);
      });
      throw new PaymentJobError(code);
    }
  }

  /** One validation call and what follows from it; the error code when the call failed. */
  private async validate(
    tenantId: string,
    intent: IntentFacts,
    creds: SslcommerzCredentials,
    valId: string,
  ): Promise<ProviderErrorCode | null> {
    const outcome = await this.provider.confirm(creds, { tranId: intent.tranId, valId });
    if (outcome.kind === 'PAID') {
      await this.settle.settlePaid(tenantId, intent.id, intent.payerUserId, outcome);
      return null;
    }
    // A made-up val_id (INVALID), a pending or failed one, or no answer: recorded, nothing else.
    await this.jobs.run(tenantId, () =>
      this.events.record({
        intentId: intent.id,
        kind: 'VALIDATE',
        outcome: outcome.kind === 'ERROR' ? outcome.code : outcome.kind,
        tranId: intent.tranId,
        valId,
      }),
    );
    return outcome.kind === 'ERROR' ? outcome.code : null;
  }

  private async query(
    tenantId: string,
    intent: IntentFacts,
    creds: SslcommerzCredentials,
    signals: { kind: string; outcome: string | null; fields: unknown }[],
    validated: Set<string>,
    tried: Set<string>,
  ): Promise<ProviderErrorCode | null> {
    const attempts = await this.provider.query(creds, intent.tranId);
    const statuses = Array.isArray(attempts) ? attempts.map((a) => a.status) : [];
    await this.jobs.run(tenantId, () =>
      this.events.record({
        intentId: intent.id,
        kind: 'QUERY',
        outcome: Array.isArray(attempts)
          ? statuses.length > 0
            ? [...new Set(statuses)].join(',').slice(0, 40)
            : 'NONE'
          : attempts.code,
        tranId: intent.tranId,
      }),
    );
    if (!Array.isArray(attempts)) return attempts.code;

    let failure: ProviderErrorCode | null = null;
    for (const attempt of attempts) {
      if (attempt.status !== 'VALID' && attempt.status !== 'VALIDATED') continue;
      if (
        !isGatewayRef(attempt.valId) ||
        validated.has(attempt.valId) ||
        tried.has(attempt.valId)
      ) {
        continue;
      }
      tried.add(attempt.valId);
      failure = (await this.validate(tenantId, intent, creds, attempt.valId)) ?? failure;
    }
    const live = attempts.some((a) => ['VALID', 'VALIDATED', 'PENDING'].includes(a.status));
    if (!live && failure === null) {
      // The session is over with nothing paid: a failed or cancelled return (the path's word), or
      // an IPN that said so, closes an open intent. A query alone closes nothing (P7b expires it).
      const closing = signals
        .filter(
          (s) =>
            (s.kind === 'RETURN' && (s.outcome === 'FAIL' || s.outcome === 'CANCEL')) ||
            (s.kind === 'IPN' &&
              ['FAILED', 'CANCELLED', 'EXPIRED', 'UNATTEMPTED'].includes(
                String((s.fields as Record<string, unknown> | null)?.['status'] ?? ''),
              )),
        )
        .at(-1);
      if (closing) {
        const cancelled =
          closing.outcome === 'CANCEL' ||
          (closing.fields as Record<string, unknown> | null)?.['status'] === 'CANCELLED';
        await this.settle.closeUnpaid(
          tenantId,
          intent.id,
          intent.payerUserId,
          cancelled ? 'CANCELLED' : 'FAILED',
        );
      }
    }
    return failure;
  }

  /**
   * The `unmatched-check` job: an IPN that named no intent of the institute. When it carries a
   * val_id and the institute's budget allows, ask the gateway with the institute's own
   * credentials. Money of one of our intents (its own tran_id) is confirmed through that intent;
   * money of this store with no intent becomes an UNMATCHED VALIDATE event (P7b's queue).
   */
  async unmatchedCheck(data: UnmatchedJobData): Promise<void> {
    const read = await this.jobs.run(data.tenantId, async () => {
      const tx = this.db.tx;
      const event = await tx.paymentGatewayEvent.findUnique({
        where: { id: data.eventId },
        select: { intentId: true, kind: true, tranId: true, valId: true },
      });
      if (!event || event.intentId !== null || event.kind !== 'IPN' || !event.valId) return null;
      const account = await tx.paymentGatewayAccount.findFirst({
        where: { provider: 'SSLCOMMERZ' },
        select: { id: true },
      });
      if (!account) return null;
      try {
        return { event, creds: await this.credentials.read(account.id) };
      } catch (error) {
        if (!(error instanceof PaymentCredentialsError)) throw error;
        return null;
      }
    });
    if (!read) return;
    const allowed = await this.limiter.tryConsume({
      key: `pay-unmatched:${data.tenantId}`,
      limit: UNMATCHED_PER_HOUR,
      windowSec: 3600,
    });
    if (!allowed) return;
    const { event, creds } = read;
    const outcome = await this.provider.confirm(creds, {
      tranId: event.tranId ?? '',
      valId: event.valId!,
    });
    const intentId = await this.jobs.run(data.tenantId, async () => {
      if (outcome.kind === 'PAID' && outcome.tranId) {
        const intent = await this.db.tx.paymentIntent.findFirst({
          where: { tranId: outcome.tranId },
          select: { id: true },
        });
        if (intent) return intent.id;
      }
      await this.events.record({
        intentId: null,
        kind: 'VALIDATE',
        outcome:
          outcome.kind === 'PAID'
            ? outcome.repeated
              ? 'VALIDATED'
              : 'VALID'
            : outcome.kind === 'ERROR'
              ? outcome.code
              : outcome.kind,
        tranId: outcome.kind === 'PAID' ? outcome.tranId : event.tranId,
        valId: event.valId,
        fields: outcome.kind === 'PAID' ? outcome.reported : {},
        reviewReason: outcome.kind === 'PAID' ? 'UNMATCHED' : null,
      });
      return null;
    });
    if (intentId) {
      // Our own intent's money, under another IPN: that intent asks the gateway itself.
      await queueConfirm(this.queue, { tenantId: data.tenantId, intentId }).catch(
        (error: unknown) => this.logger.warn(`Could not queue a confirm: ${(error as Error).name}`),
      );
    }
  }
}

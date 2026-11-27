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
  ATTEMPT_STATUSES,
  LAPSED_ATTEMPTS,
  LIVE_ATTEMPTS,
  OVER_ATTEMPTS,
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
/**
 * The bound on what signals make us ask the gateway with the institute's credentials (P7a2-x24):
 * anyone with the tran_id can send a return with a made-up val_id. New val_ids validated directly
 * per round, and per payment and hour (separately for the val_ids SSLCommerz's listed addresses
 * brought and those anyone else did, so a flood never uses up the real IPN's). The rest are left
 * to the query by tran_id, which lists every real attempt; it is never refused.
 */
const VALIDATIONS_PER_ROUND = 3;
const VALIDATIONS_PER_HOUR = 10;

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
  /** The session's lifetime (P7a-F, an hour after the checkout). */
  expiresAt: Date;
  status: string;
  payerUserId: string;
  accountId: string;
}

/**
 * The `confirm` job (sprint 1 P7a2, docs/payments.md → Confirmation): nothing in a signal is
 * trusted. While the payment is open, a few new validation IDs a return or IPN carried are
 * validated with SSLCommerz's validation API (the institute's own credentials, outside any
 * transaction), and each answer settled. Otherwise, or for the rest, ask the transaction query API
 * by our tran_id: it answers for every signal stored before it, and every successful attempt it
 * lists is then validated the same way (nothing posts from a query answer alone). A gateway error
 * makes the job fail with a fixed code so BullMQ retries it (6 attempts from 30 s); the intent
 * stays as it is.
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
        select: {
          id: true,
          tranId: true,
          status: true,
          payerUserId: true,
          accountId: true,
          expiresAt: true,
        },
      });
      if (!intent) return null;
      const events = await tx.paymentGatewayEvent.findMany({
        where: { intentId: intent.id },
        orderBy: { receivedAt: 'asc' },
        select: {
          kind: true,
          outcome: true,
          valId: true,
          fields: true,
          sourceListed: true,
          receivedAt: true,
        },
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
    let leftToQuery = false;
    for (let round = 0; ; round++) {
      const read = await this.read(data);
      if (!read?.creds) return;
      const { intent, events, creds } = read;
      const open = intent.status === 'CREATED' || intent.status === 'REDIRECTED';
      const validations = events.filter((e) => e.kind === 'VALIDATE' && e.valId);
      // Answered for good (PENDING is not, P7a2-x27), and money seen (VALID, VALIDATED).
      const answered = new Set(
        validations.filter((e) => isFinalAnswer(e.outcome)).map((e) => e.valId!),
      );
      const settled = new Set(
        validations
          .filter((e) => e.outcome === 'VALID' || e.outcome === 'VALIDATED')
          .map((e) => e.valId!),
      );
      // The query lists every attempt of our tran_id: it has answered for each signal stored
      // before it was asked, whatever val_id that signal carried (P7a2-x24).
      const lastQuery =
        events.filter((e) => e.kind === 'QUERY' && !isErrorCode(e.outcome)).at(-1)?.receivedAt ??
        null;
      const signals = events.filter((e) => e.kind === 'RETURN' || e.kind === 'IPN');
      const since = signals.filter((e) => lastQuery === null || e.receivedAt > lastQuery);
      // val_ids SSLCommerz's listed addresses brought (at any time). Any other signal can be sent
      // by anyone with the tran_id: another payment's val_id from such a signal alone never sends
      // this payment to review (P7a2-x30).
      const fromListed = new Set(
        signals.filter((e) => e.sourceListed === true && e.valId).map((e) => e.valId!),
      );
      const waiting = (e: { valId: string | null }) =>
        e.valId !== null && !answered.has(e.valId) && !tried.has(e.valId);
      // Each new val_id once: those SSLCommerz's listed addresses brought first, then the oldest.
      const fresh = [
        ...new Map(
          [...since.filter((e) => e.sourceListed), ...since.filter((e) => !e.sourceListed)]
            .filter(waiting)
            .map((e) => [e.valId!, e.sourceListed === true] as const),
        ),
      ];

      // Only while the payment is open, a few a round and within the payment's budget; signals
      // that arrived while this job ran are taken in the next round.
      if (open && !leftToQuery && fresh.length > 0 && round < MAX_ROUNDS) {
        for (const [valId, listed] of fresh.slice(0, VALIDATIONS_PER_ROUND)) {
          const allowed = await this.limiter.tryConsume({
            key: `pay-val-${listed ? 'listed' : 'other'}:${intent.id}`,
            limit: VALIDATIONS_PER_HOUR,
            windowSec: 3600,
          });
          if (!allowed) {
            leftToQuery = true;
            continue;
          }
          tried.add(valId);
          validatedAny = true;
          failure =
            (await this.validate(data.tenantId, intent, creds, valId, fromListed.has(valId))) ??
            failure;
        }
        if (fresh.length > VALIDATIONS_PER_ROUND) leftToQuery = true;
        continue;
      }

      // Ask by tran_id while the payment is open (a failed or cancelled return, a made-up or
      // pending val_id, a heal, val_ids left to the query), or when a signal since the last query
      // is still unaccounted for: a new val_id on a closed payment (a second payment, or a made-up
      // one: never validated unless the query lists it), or a signal without one that came with no
      // validation in this job (a late payment). Once per job.
      const unaccounted = since.some((e) => (e.valId !== null ? waiting(e) : !validatedAny));
      if (failure === null && (open || unaccounted)) {
        failure = await this.query(data.tenantId, intent, creds, signals, settled, tried);
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

  /**
   * One validation call and what follows from it; the error code when the call failed. `trusted`:
   * the val_id came from SSLCommerz's listed address or from our own query, not only from signals
   * anyone can send (P7a2-x30).
   */
  private async validate(
    tenantId: string,
    intent: IntentFacts,
    creds: SslcommerzCredentials,
    valId: string,
    trusted: boolean,
  ): Promise<ProviderErrorCode | null> {
    const outcome = await this.provider.confirm(creds, { tranId: intent.tranId, valId });
    if (outcome.kind === 'PAID') {
      await this.settle.settlePaid(tenantId, intent.id, intent.payerUserId, outcome, {
        forgeable: !trusted,
      });
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
    settled: Set<string>,
    tried: Set<string>,
  ): Promise<ProviderErrorCode | null> {
    // Recorded as asked now: a signal that arrives while the gateway answers is not one it
    // answered for.
    const askedAt = this.clock.now();
    const attempts = await this.provider.query(creds, intent.tranId);
    const statuses = Array.isArray(attempts) ? attempts.map((a) => a.status) : [];
    await this.jobs.run(tenantId, () =>
      this.events.record({
        intentId: intent.id,
        kind: 'QUERY',
        // In ATTEMPT_STATUSES' order, so a paid or pending attempt is never cut off at 40
        // characters (the payment's page reads it: queryFoundNothingLive).
        outcome: Array.isArray(attempts)
          ? statuses.length > 0
            ? ATTEMPT_STATUSES.filter((s) => statuses.includes(s))
                .join(',')
                .slice(0, 40)
            : 'NONE'
          : attempts.code,
        tranId: intent.tranId,
        at: askedAt,
      }),
    );
    if (!Array.isArray(attempts)) return attempts.code;

    let failure: ProviderErrorCode | null = null;
    // Every successful attempt it lists whose money we have not seen yet (an earlier answer of
    // PENDING or INVALID included): the gateway lists only real attempts of our tran_id.
    for (const attempt of attempts) {
      if (attempt.status !== 'VALID' && attempt.status !== 'VALIDATED') continue;
      if (!isGatewayRef(attempt.valId) || settled.has(attempt.valId) || tried.has(attempt.valId)) {
        continue;
      }
      tried.add(attempt.valId);
      failure = (await this.validate(tenantId, intent, creds, attempt.valId, true)) ?? failure;
    }
    const listed = new Set<string>(attempts.map((a) => a.status));
    const live = LIVE_ATTEMPTS.some((status) => listed.has(status));
    // SSLCommerz's query documents VALID, VALIDATED, PENDING and FAILED only; a session cancelled
    // before any attempt, or left to time out, may be listed as UNATTEMPTED or EXPIRED. Those are
    // true of a payer still on the gateway's page too, and a forged return makes us ask: they
    // count as over only past the session's lifetime (the intent's expires_at), and only from
    // our own query by our tran_id, never from a signal (P7a2-x31).
    const lapsed =
      askedAt.getTime() >= intent.expiresAt.getTime() &&
      LAPSED_ATTEMPTS.some((status) => listed.has(status));
    const over = lapsed || OVER_ATTEMPTS.some((status) => listed.has(status));
    if (!live && over && failure === null) {
      // The session is over with nothing paid, and the gateway itself lists the failed or
      // cancelled attempt (or, past the session's lifetime, an unattempted or expired one): then
      // a failed or cancelled return (the path's word), or an IPN that said so, closes an open
      // intent. Nothing found closes nothing
      // (P7a2-x26): a return needs only the tran_id, so anyone who has it (even an <img> link)
      // could otherwise close a payment still in progress, and the real payment would then wait
      // for review as a late success. A query alone closes nothing either (P7b expires it).
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
        const said =
          closing.outcome === 'CANCEL' ||
          (closing.fields as Record<string, unknown> | null)?.['status'] === 'CANCELLED'
            ? 'CANCELLED'
            : 'FAILED';
        // The signal's word when the gateway lists it; otherwise the gateway's (FAILED, then
        // CANCELLED); for an attempt listed only as UNATTEMPTED or EXPIRED, the signal's.
        const word = listed.has(said)
          ? said
          : listed.has('FAILED')
            ? 'FAILED'
            : listed.has('CANCELLED')
              ? 'CANCELLED'
              : said;
        await this.settle.closeUnpaid(tenantId, intent.id, intent.payerUserId, word);
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

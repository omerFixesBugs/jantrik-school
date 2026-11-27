import { Injectable } from '@nestjs/common';
import {
  dateFromDb,
  methodFromInstrument,
  PAYMENT_REVIEW_REASONS,
  todayIn,
  type PaymentReviewReason,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { Clock } from '../common/clock.js';
import { FeeCollectionService } from '../fees/collection/fee-collection.service.js';
import { lockPaymentIntent, lockStudentFees, lockTenantFees } from '../fees/fee-locks.js';
import type { GatewayVoid } from '../fees/fee-online-hooks.js';
import { Db } from '../tenancy/db.service.js';
import { TenantJobRunner } from '../tenancy/tenant-job-runner.service.js';
import { PaymentEventsService } from './payment-events.service.js';
import type { ProviderOutcome } from './provider.js';
import { decideSettlement, type SettleDecision } from './settle-decision.js';

const ENTITY = 'payment_intent';

export type PaidOutcome = Extract<ProviderOutcome, { kind: 'PAID' }>;

/** What settle did, for the confirm job and the tests. */
export type SettleResult = SettleDecision['kind'] | 'GONE';

/** A unique violation (Prisma P2002 or PostgreSQL 23505), whatever layer reports it. */
export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.code === 'P2002' || e.code === '23505') return true;
  if (typeof e.message === 'string' && /unique constraint|23505|duplicate key/i.test(e.message)) {
    return true;
  }
  return e.cause !== undefined && e.cause !== error && isUniqueViolation(e.cause);
}

/** An identifier as the table takes it: printable ASCII, no spaces, at most `max`. */
const printable = (value: string | null, max: number): string | null =>
  value && value.length <= max && /^[\x21-\x7e]+$/.test(value) ? value : null;
/** A label (a card type has spaces: "DBBLMOBILEB-Dbbl Mobile Banking"), at most `max`. */
const label = (value: string | null, max: number): string | null => {
  const v = value?.trim();
  return v && v.length <= max && /^[\x20-\x7e]+$/.test(v) ? v : null;
};

/** The enum's order, with no repeats. */
const mergeReasons = (
  had: readonly PaymentReviewReason[],
  add: readonly PaymentReviewReason[],
): PaymentReviewReason[] =>
  PAYMENT_REVIEW_REASONS.filter((r) => had.includes(r) || add.includes(r));

/**
 * The only place that posts gateway money (sprint 1 P7a2, docs/payments.md → settle; S23). Each
 * call is one transaction acting as the guardian who paid, under the tenant's fee lock (shared),
 * the student's lock and the intent's row lock, so the counter, a void and three signals for one
 * payment queue up and make one decision at a time. A VALIDATE event is written first, whatever
 * follows; then the decision table (settle-decision.ts) either posts the payment through
 * FeeCollectionService.recordPayment (channel GATEWAY, paid on the checkout day) or sends the
 * intent to review with its reasons and the money facts, with no payment and no receipt.
 */
@Injectable()
export class SettleService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly jobs: TenantJobRunner,
    private readonly collection: FeeCollectionService,
    private readonly events: PaymentEventsService,
  ) {}

  /**
   * Settle one validated payment for the intent. A unique violation while posting (the
   * bank_tran_id already on a live payment, or a second payment for the intent) rolls everything
   * back; it is then settled again as a DUPLICATE review, the money facts kept. `forgeable`: the
   * val_id came only from signals anyone with the tran_id can send (P7a2-x30).
   */
  async settlePaid(
    tenantId: string,
    intentId: string,
    payerUserId: string,
    paid: PaidOutcome,
    opts: { forgeable?: boolean } = {},
  ): Promise<SettleResult> {
    const forgeable = opts.forgeable === true;
    try {
      return await this.settleOnce(tenantId, intentId, payerUserId, paid, false, forgeable);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.settleOnce(tenantId, intentId, payerUserId, paid, true, forgeable);
    }
  }

  private settleOnce(
    tenantId: string,
    intentId: string,
    payerUserId: string,
    paid: PaidOutcome,
    duplicate: boolean,
    forgeable: boolean,
  ): Promise<SettleResult> {
    return this.jobs.run(
      tenantId,
      async () => {
        const tx = this.db.tx;
        const head = await tx.paymentIntent.findUnique({
          where: { id: intentId },
          select: { studentId: true },
        });
        if (!head) return 'GONE';
        await lockTenantFees(tx, 'shared');
        await lockStudentFees(tx, head.studentId);
        await lockPaymentIntent(tx, intentId);
        const intent = await tx.paymentIntent.findUniqueOrThrow({
          where: { id: intentId },
          include: {
            dues: { select: { dueId: true, plannedPrincipalPaisa: true, plannedFinePaisa: true } },
          },
        });
        const sameTran = paid.tranId === intent.tranId;
        const otherIntent =
          !sameTran && paid.tranId
            ? (await tx.paymentIntent.count({ where: { tranId: paid.tranId } })) > 0
            : false;
        const open = intent.status === 'CREATED' || intent.status === 'REDIRECTED';
        const duesChanged =
          sameTran && open && intent.valId === null ? await this.duesChanged(intent) : false;
        const decision = decideSettlement(
          {
            status: intent.status,
            tranId: intent.tranId,
            amountPaisa: intent.amountPaisa,
            valId: intent.valId,
          },
          paid,
          { duesChanged, otherIntent, duplicate, forgeable },
        );

        await this.events.record({
          intentId,
          kind: 'VALIDATE',
          outcome: paid.repeated ? 'VALIDATED' : 'VALID',
          tranId: paid.tranId,
          valId: paid.valId,
          fields: paid.reported,
          reviewReason:
            decision.kind === 'EVENT_ONLY' || decision.kind === 'REVIEW'
              ? decision.eventReason
              : null,
        });

        const now = this.clock.now();
        // Nothing (৳0.00) is no amount: unknown, as for money items (review round 2, probe F),
        // so the money can still be refunded outside; the database refuses 0.
        const validatedAmountPaisa =
          paid.amountPaisa !== null && paid.amountPaisa >= 1 ? paid.amountPaisa : null;
        const facts = {
          valId: paid.valId,
          bankTranId: printable(paid.bankTranId, 100),
          instrument: label(paid.instrument, 50),
          method: methodFromInstrument(paid.instrument, paid.cardBrand),
          validatedAmountPaisa,
          storeAmountPaisa:
            paid.storeAmountPaisa !== null &&
            validatedAmountPaisa !== null &&
            paid.storeAmountPaisa <= validatedAmountPaisa
              ? paid.storeAmountPaisa
              : null,
          validatedCurrency: printable(paid.currencyType, 10),
          risk: paid.risk,
          gatewayPaidAt: paid.paidAt,
        };

        if (decision.kind === 'REVIEW') {
          const reasons = mergeReasons(intent.reviewReasons, decision.addReasons);
          await tx.paymentIntent.update({
            where: { id: intentId },
            data: {
              status: 'NEEDS_REVIEW',
              reviewReasons: { set: reasons },
              reviewSince: intent.reviewSince ?? now,
              closedAt: intent.closedAt ?? now,
              ...(decision.recordFacts ? facts : {}),
            },
            select: { id: true },
          });
          await this.audit.record({
            entity: ENTITY,
            entityId: intentId,
            action: 'UPDATE',
            oldValues: { status: intent.status, reasons: intent.reviewReasons },
            newValues: {
              status: 'NEEDS_REVIEW',
              reasons,
              ...(decision.recordFacts ? { valId: paid.valId, validatedAmountPaisa } : {}),
            },
          });
        } else if (decision.kind === 'POST') {
          // Recorded today (the receipt's year and the daily closing), in the institute's zone.
          const tenant = await tx.tenant.findFirstOrThrow({ select: { timezone: true } });
          const today = todayIn(tenant.timezone, now);
          const dues = await this.collection.openDues(
            intent.studentId,
            intent.dues.map((d) => d.dueId),
          );
          const paymentId = await this.collection.recordPayment({
            studentId: intent.studentId,
            dues,
            amountPaisa: intent.amountPaisa,
            method: facts.method,
            channel: 'GATEWAY',
            trxId: facts.bankTranId,
            senderPhone: null,
            // The fines were counted to the checkout day: the payment counts as paid then (P7a-E).
            paidOn: dateFromDb(intent.pricedOn),
            recordedOn: today,
            clientRequestId: intent.id,
            paymentIntentId: intent.id,
          });
          await tx.paymentIntent.update({
            where: { id: intentId },
            data: {
              status: 'PAID',
              feePaymentId: paymentId,
              closedAt: intent.closedAt ?? now,
              ...facts,
            },
            select: { id: true },
          });
          await this.audit.record({
            entity: ENTITY,
            entityId: intentId,
            action: 'UPDATE',
            oldValues: { status: intent.status },
            newValues: { status: 'PAID', paymentId, valId: paid.valId },
          });
        }
        return decision.kind;
      },
      { actorUserId: payerUserId },
    );
  }

  /**
   * DUES_CHANGED: a due no longer open, or what it owes on the checkout day (principal, fine)
   * differs from the snapshot (a counter payment, a waiver, a recalculation, a cancel).
   */
  private async duesChanged(intent: {
    pricedOn: Date;
    dues: { dueId: string; plannedPrincipalPaisa: number; plannedFinePaisa: number }[];
  }): Promise<boolean> {
    const rows = await this.db.tx.feeDue.findMany({
      where: { id: { in: intent.dues.map((d) => d.dueId) } },
    });
    const pricedOn = dateFromDb(intent.pricedOn);
    for (const planned of intent.dues) {
      const row = rows.find((r) => r.id === planned.dueId);
      if (!row || row.status !== 'OPEN') return true;
      const owed = this.collection.owedOn(row, pricedOn);
      if (
        owed.principal !== planned.plannedPrincipalPaisa ||
        owed.fine !== planned.plannedFinePaisa
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * A FAIL or CANCEL return, or an IPN that said the payment failed, once a query found no
   * successful or pending attempt: the open intent is closed (the payer may start again).
   */
  closeUnpaid(
    tenantId: string,
    intentId: string,
    payerUserId: string,
    word: 'FAILED' | 'CANCELLED',
  ): Promise<boolean> {
    return this.jobs.run(
      tenantId,
      async () => {
        const tx = this.db.tx;
        const head = await tx.paymentIntent.findUnique({
          where: { id: intentId },
          select: { studentId: true },
        });
        if (!head) return false;
        await lockTenantFees(tx, 'shared');
        await lockStudentFees(tx, head.studentId);
        await lockPaymentIntent(tx, intentId);
        const intent = await tx.paymentIntent.findUniqueOrThrow({
          where: { id: intentId },
          select: { status: true },
        });
        if (intent.status !== 'CREATED' && intent.status !== 'REDIRECTED') return false;
        await tx.paymentIntent.update({
          where: { id: intentId },
          data: { status: word, closedAt: this.clock.now() },
          select: { id: true },
        });
        await this.audit.record({
          entity: ENTITY,
          entityId: intentId,
          action: 'UPDATE',
          oldValues: { status: intent.status },
          newValues: { status: word },
        });
        return true;
      },
      { actorUserId: payerUserId },
    );
  }

  /**
   * The void hook (FeeOnlineHooks.gatewayVoided), in the void's transaction with the student's
   * lock held: the intent goes back to review with VOIDED and without its payment (P7a-G).
   */
  async gatewayVoided(payment: GatewayVoid): Promise<void> {
    const tx = this.db.tx;
    await lockPaymentIntent(tx, payment.paymentIntentId);
    const intent = await tx.paymentIntent.findUnique({
      where: { id: payment.paymentIntentId },
      select: { status: true, feePaymentId: true, reviewReasons: true },
    });
    if (!intent || intent.status !== 'PAID' || intent.feePaymentId !== payment.paymentId) return;
    const reasons = mergeReasons(intent.reviewReasons, ['VOIDED']);
    await tx.paymentIntent.update({
      where: { id: payment.paymentIntentId },
      data: {
        status: 'NEEDS_REVIEW',
        feePaymentId: null,
        reviewReasons: { set: reasons },
        reviewSince: this.clock.now(),
      },
      select: { id: true },
    });
    await this.audit.record({
      entity: ENTITY,
      entityId: payment.paymentIntentId,
      action: 'UPDATE',
      oldValues: { status: 'PAID', paymentId: payment.paymentId },
      newValues: { status: 'NEEDS_REVIEW', reasons },
    });
  }

  /** The receipt's online part (FeeOnlineHooks.receiptOnline). */
  async receiptOnline(intentId: string): Promise<{ tranId: string; instrument: string | null }> {
    const intent = await this.db.tx.paymentIntent.findUniqueOrThrow({
      where: { id: intentId },
      select: { tranId: true, instrument: true },
    });
    return intent;
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import {
  dateFromDb,
  DISMISS_CHECK_MINUTES,
  isWellFormedBankTranId,
  methodFromInstrument,
  ONLINE_PAYMENTS_PAGE_SIZE,
  parseGatewayAmount,
  receiptNumber,
  signalFields,
  todayIn,
  wallClockToUtc,
  addDays,
  type FeeReceipt,
  type IsoDate,
  type OnlineMoneyView,
  type OnlinePaymentCheckQueued,
  type OnlinePaymentList,
  type OnlinePaymentStaffView,
  type PaymentReviewQueue,
  type PaymentReviewReason,
  type PaymentSignalItem,
} from '@jantrik/shared';
import type { z } from 'zod';
import type {
  applyOnlinePaymentSchema,
  dismissReviewSchema,
  onlinePaymentsQuerySchema,
  refundedOutsideSchema,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../common/request-context.js';
import { FeeCollectionService } from '../fees/collection/fee-collection.service.js';
import { FeeDuesService } from '../fees/dues/fee-dues.service.js';
import { lockPaymentIntent, lockStudentFees, lockTenantFees } from '../fees/fee-locks.js';
import { RateLimiter } from '../redis/rate-limiter.service.js';
import { staffNames, staffRef } from '../staff/staff.module.js';
import { Db } from '../tenancy/db.service.js';
import { lockPaymentMoney, lockPaymentSignals } from './payment-locks.js';
import { ReconcileQueue, ReconcileService } from './reconcile.service.js';
import { parseTranDate } from './sslcommerz/sslcommerz.schemas.js';

type ApplyInput = z.output<typeof applyOnlinePaymentSchema>;
type ListQuery = z.output<typeof onlinePaymentsQuerySchema>;
type RefundInput = z.output<typeof refundedOutsideSchema>;
type DismissInput = z.output<typeof dismissReviewSchema>;

const INTENT = 'payment_intent';
const SIGNAL = 'payment_signal_review';
/** Unmatched IPNs SSLCommerz called invalid are listed this long (collapsed; not items). */
const CHECKED_DAYS = 30;

const staffInclude = {
  student: {
    select: {
      id: true,
      studentCode: true,
      nameBn: true,
      nameEn: true,
      enrolments: {
        where: { academicYear: { isCurrent: true } },
        take: 1,
        select: { classLevel: { select: { nameBn: true, nameEn: true } } },
      },
    },
  },
  dues: {
    orderBy: { createdAt: 'asc' },
    select: {
      plannedPrincipalPaisa: true,
      plannedFinePaisa: true,
      due: {
        include: {
          feeHead: { select: { nameBn: true, nameEn: true, sortOrder: true } },
          feeTerm: { select: { nameBn: true, nameEn: true } },
        },
      },
    },
  },
  feePayment: { select: { id: true, receiptYear: true, receiptNo: true } },
} satisfies Prisma.PaymentIntentInclude;
type StaffRow = Prisma.PaymentIntentGetPayload<{ include: typeof staffInclude }>;

const signalInclude = {
  intent: {
    select: {
      id: true,
      tranId: true,
      student: { select: { id: true, studentCode: true, nameBn: true, nameEn: true } },
    },
  },
  review: true,
} satisfies Prisma.PaymentGatewayEventInclude;
type SignalRow = Prisma.PaymentGatewayEventGetPayload<{ include: typeof signalInclude }>;

/**
 * The review queue for online payments (sprint 1 P7b, docs/payments.md → The review queue; S23):
 * intents in NEEDS_REVIEW and money items (VALIDATE events marked UNMATCHED or DUPLICATE). An
 * OWNER or ADMIN decides each in their request transaction, under the tenant's fee lock (shared),
 * the student's lock and the intent's row lock (a money item: its intent's, then its val_id's), so
 * two people, a late signal and the counter make one decision at a time:
 *
 * - **apply**: the validated money to chosen dues of the child (and periods ahead) as one gateway
 *   payment through FeeCollectionService.recordPayment, paid on the gateway's day (P7b-F); less
 *   than the money only with the rest recorded as refunded outside (P7b-E); never in another
 *   currency (P7b-G);
 * - **refunded outside**: the whole money given back outside the app (P7b-I; final, P7b-N);
 * - **dismiss**: only what holds no money, after a check in the last 15 minutes found nothing
 *   (P7b-E); a money item only as a repeat record of money held elsewhere.
 *
 * Money items are never applied (P7b-H). Every decision is audited with the old and new state.
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly limiter: RateLimiter,
    private readonly dues: FeeDuesService,
    private readonly collection: FeeCollectionService,
    private readonly reconcile: ReconcileService,
    private readonly reconcileQueue: ReconcileQueue,
  ) {}

  // ───────────────────────────── Reading ─────────────────────────────

  /** GET /fees/online-payments/review: oldest first; heals overdue checks (once a minute). */
  async queue(): Promise<PaymentReviewQueue> {
    await this.reconcile.healOverdue();
    const tx = this.db.tx;
    const [rows, signals, checked] = await Promise.all([
      tx.paymentIntent.findMany({
        where: { status: 'NEEDS_REVIEW' },
        orderBy: [{ reviewSince: 'asc' }, { createdAt: 'asc' }],
        take: 200,
        include: staffInclude,
      }),
      tx.paymentGatewayEvent.findMany({
        where: { kind: 'VALIDATE', reviewReason: { not: null }, review: { is: null } },
        orderBy: { receivedAt: 'asc' },
        take: 200,
        include: signalInclude,
      }),
      tx.paymentGatewayEvent.findMany({
        where: {
          kind: 'VALIDATE',
          intentId: null,
          reviewReason: null,
          outcome: 'INVALID',
          receivedAt: { gte: new Date(this.clock.now().getTime() - CHECKED_DAYS * 86_400_000) },
        },
        orderBy: { receivedAt: 'desc' },
        take: 50,
        select: { id: true, receivedAt: true, tranId: true, valId: true },
      }),
    ]);
    const intents = await this.staffViews(rows);
    const items = await this.signalViews(signals);
    return {
      intents,
      signals: items,
      checked: checked.map((c) => ({
        eventId: c.id,
        receivedAt: c.receivedAt.toISOString(),
        tranId: c.tranId,
        valId: c.valId,
      })),
      count: intents.length + items.length,
    };
  }

  /** The dashboard's count (FeeOnlineHooks.toReviewCount): intents and money items. */
  async count(): Promise<number> {
    const tx = this.db.tx;
    const [intents, signals] = await Promise.all([
      tx.paymentIntent.count({ where: { status: 'NEEDS_REVIEW' } }),
      tx.paymentGatewayEvent.count({
        where: { kind: 'VALIDATE', reviewReason: { not: null }, review: { is: null } },
      }),
    ]);
    return intents + signals;
  }

  /** GET /fees/online-payments: newest first, 50 a page. */
  async list(q: ListQuery): Promise<OnlinePaymentList> {
    const tx = this.db.tx;
    const { timezone } = await tx.tenant.findFirstOrThrow({ select: { timezone: true } });
    const createdAt: Prisma.DateTimeFilter = {};
    if (q.from) createdAt.gte = wallClockToUtc(`${q.from} 00:00:00`, timezone);
    if (q.to) createdAt.lt = wallClockToUtc(`${addDays(q.to, 1)} 00:00:00`, timezone);
    const where: Prisma.PaymentIntentWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.from || q.to ? { createdAt } : {}),
      ...(q.q
        ? { OR: [{ tranId: q.q }, { bankTranId: q.q }, { student: { studentCode: q.q } }] }
        : {}),
    };
    const [total, rows] = await Promise.all([
      tx.paymentIntent.count({ where }),
      tx.paymentIntent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * ONLINE_PAYMENTS_PAGE_SIZE,
        take: ONLINE_PAYMENTS_PAGE_SIZE,
        include: {
          student: { select: { id: true, studentCode: true, nameBn: true, nameEn: true } },
          feePayment: { select: { receiptYear: true, receiptNo: true } },
        },
      }),
    ]);
    return {
      page: q.page,
      pageSize: ONLINE_PAYMENTS_PAGE_SIZE,
      total,
      rows: rows.map((r) => ({
        id: r.id,
        tranId: r.tranId,
        status: r.status,
        reasons: r.reviewReasons,
        amountPaisa: r.amountPaisa,
        method: r.method,
        bankTranId: r.bankTranId,
        createdAt: r.createdAt.toISOString(),
        student: r.student,
        receiptNumber: r.feePayment
          ? receiptNumber(r.feePayment.receiptYear, r.feePayment.receiptNo)
          : null,
        lastCheck: this.lastCheck(r),
      })),
    };
  }

  /** GET /fees/online-payments/:id: the intent, its dues, its events and its decision. */
  async detail(intentId: string): Promise<OnlinePaymentStaffView> {
    const tx = this.db.tx;
    const row = await tx.paymentIntent.findUnique({
      where: { id: intentId },
      include: staffInclude,
    });
    if (!row) throw new NotFoundException('Online payment not found');
    const [view] = await this.staffViews([row]);
    const events = await tx.paymentGatewayEvent.findMany({
      where: { intentId },
      orderBy: { receivedAt: 'asc' },
      select: {
        id: true,
        kind: true,
        outcome: true,
        receivedAt: true,
        valId: true,
        tranId: true,
        reviewReason: true,
        fields: true,
      },
    });
    return {
      ...view!,
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        outcome: e.outcome,
        receivedAt: e.receivedAt.toISOString(),
        valId: e.valId,
        tranId: e.tranId,
        reviewReason: e.reviewReason as 'UNMATCHED' | 'DUPLICATE' | null,
        // The stored whitelist again (never a card number, a signature or the payer).
        fields: signalFields(e.fields),
      })),
    };
  }

  private lastCheck(row: { lastCheckedAt: Date | null; lastCheckOutcome: string | null }) {
    return row.lastCheckedAt && row.lastCheckOutcome
      ? { at: row.lastCheckedAt.toISOString(), outcome: row.lastCheckOutcome }
      : null;
  }

  /** A check in the last 15 minutes found no success (dismiss may go ahead). */
  private checkedClean(row: { lastCheckedAt: Date | null; lastCheckOutcome: string | null }) {
    return (
      row.lastCheckOutcome === 'NO_SUCCESS' &&
      row.lastCheckedAt !== null &&
      this.clock.now().getTime() - row.lastCheckedAt.getTime() <= DISMISS_CHECK_MINUTES * 60_000
    );
  }

  /** Why apply is refused for an intent in review, or null when it may go ahead. */
  private applyBlock(row: {
    valId: string | null;
    validatedAmountPaisa: number | null;
    validatedCurrency: string | null;
    bankTranId: string | null;
    method: string | null;
    reviewReasons: PaymentReviewReason[];
  }): { status: number; code: string; message: string } | null {
    if (row.valId === null || row.method === null) {
      return { status: 422, code: 'NO_MONEY', message: 'No money was confirmed for this payment' };
    }
    // We only ever ask for BDT: anything else means something went wrong (P7b-G).
    if (row.reviewReasons.includes('CURRENCY_MISMATCH') || row.validatedCurrency !== 'BDT') {
      return {
        status: 422,
        code: 'CURRENCY_NOT_APPLICABLE',
        message: 'Money in another currency is refunded, never applied',
      };
    }
    if (row.validatedAmountPaisa === null) {
      return {
        status: 422,
        code: 'AMOUNT_UNKNOWN',
        message: 'SSLCommerz did not report a usable amount: refund it outside',
      };
    }
    if (!isWellFormedBankTranId(row.bankTranId)) {
      return {
        status: 422,
        code: 'TRX_ID_UNUSABLE',
        message: 'SSLCommerz did not report a usable transaction ID: refund it outside',
      };
    }
    return null;
  }

  private async staffViews(rows: StaffRow[]): Promise<OnlinePaymentStaffView[]> {
    if (rows.length === 0) return [];
    const tx = this.db.tx;
    const ctx = await this.dues.planContext();
    const payerIds = [...new Set(rows.map((r) => r.payerUserId))];
    const [payers, names] = await Promise.all([
      tx.guardian.findMany({
        where: { userId: { in: payerIds } },
        select: { userId: true, nameBn: true, nameEn: true },
      }),
      staffNames(
        tx,
        rows.map((r) => r.resolvedById).filter((v): v is string => !!v),
      ),
    ]);
    return rows.map((r) => {
      const inReview = r.status === 'NEEDS_REVIEW';
      const money = r.valId !== null;
      const payer = payers.find((p) => p.userId === r.payerUserId);
      const outcome =
        r.status === 'PAID' ? 'APPLIED' : r.status === 'REFUNDED_OUTSIDE' ? r.status : 'DISMISSED';
      return {
        id: r.id,
        tranId: r.tranId,
        status: r.status,
        reasons: r.reviewReasons,
        reviewSince: r.reviewSince?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        closedAt: r.closedAt?.toISOString() ?? null,
        pricedOn: dateFromDb(r.pricedOn),
        amountPaisa: r.amountPaisa,
        money: money
          ? {
              valId: r.valId,
              bankTranId: r.bankTranId,
              method: r.method,
              instrument: r.instrument,
              amountPaisa: r.validatedAmountPaisa,
              storeAmountPaisa: r.storeAmountPaisa,
              currency: r.validatedCurrency,
              risk: r.risk as 'LOW' | 'HIGH' | null,
              paidAt: r.gatewayPaidAt?.toISOString() ?? null,
            }
          : null,
        student: {
          id: r.student.id,
          studentCode: r.student.studentCode,
          nameBn: r.student.nameBn,
          nameEn: r.student.nameEn,
          classLevel: r.student.enrolments[0]?.classLevel ?? null,
        },
        payer: payer ? { nameBn: payer.nameBn, nameEn: payer.nameEn } : null,
        dues: [...r.dues]
          .sort(
            (a, b) =>
              a.due.dueDate.getTime() - b.due.dueDate.getTime() ||
              a.due.feeHead.sortOrder - b.due.feeHead.sortOrder,
          )
          .map((d) => {
            const now = this.collection.owedOn(d.due, ctx.today);
            return {
              id: d.due.id,
              head: { nameBn: d.due.feeHead.nameBn, nameEn: d.due.feeHead.nameEn },
              periodKey: d.due.periodKey,
              term: d.due.feeTerm,
              principalPaisa: d.plannedPrincipalPaisa,
              finePaisa: d.plannedFinePaisa,
              now: {
                status: d.due.status,
                principalPaisa: d.due.status === 'OPEN' ? now.principal : 0,
                finePaisa: d.due.status === 'OPEN' ? now.fine : 0,
                totalPaisa: d.due.status === 'OPEN' ? now.total : 0,
              },
            };
          }),
        lastCheck: this.lastCheck(r),
        decision:
          r.resolvedAt && r.resolutionNote
            ? {
                outcome,
                at: r.resolvedAt.toISOString(),
                by: r.resolvedById ? staffRef(names, r.resolvedById) : null,
                note: r.resolutionNote,
                appliedPaisa: r.appliedPaisa,
                refundedOutsidePaisa: r.refundedOutsidePaisa,
                refundReference: r.refundReference,
              }
            : null,
        refundedOutside:
          r.refundedOutsidePaisa !== null
            ? { amountPaisa: r.refundedOutsidePaisa, reference: r.refundReference }
            : null,
        payment:
          r.status === 'PAID' && r.feePayment
            ? {
                id: r.feePayment.id,
                receiptNumber: receiptNumber(r.feePayment.receiptYear, r.feePayment.receiptNo),
              }
            : null,
        actions: {
          apply: inReview && this.applyBlock(r) === null,
          refundOutside: inReview && money,
          dismiss: inReview && !money,
          dismissReady: inReview && !money && this.checkedClean(r),
        },
      };
    });
  }

  /** The money of a review event, as SSLCommerz's validation reported it. */
  private eventMoney(e: { valId: string | null; fields: unknown }): OnlineMoneyView {
    const f = signalFields(e.fields);
    const store = parseGatewayAmount(f.store_amount);
    const amount = parseGatewayAmount(f.amount);
    return {
      valId: e.valId,
      bankTranId: f.bank_tran_id ?? null,
      method: methodFromInstrument(f.card_type ?? null, f.card_brand ?? null),
      instrument: f.card_type ?? null,
      amountPaisa: amount,
      storeAmountPaisa: store !== null && amount !== null && store <= amount ? store : null,
      currency: f.currency_type ?? f.currency ?? null,
      risk: f.risk_level === undefined ? null : f.risk_level === '0' ? 'LOW' : 'HIGH',
      paidAt: parseTranDate(f.tran_date ?? null)?.toISOString() ?? null,
    };
  }

  /**
   * A money item may be dismissed only as a repeat record: an intent holds the same money (its
   * val_id), or another review event records it and was not itself dismissed (P7b-E).
   */
  private async isRepeat(eventId: string, valId: string | null): Promise<boolean> {
    if (!valId) return false;
    const tx = this.db.tx;
    const [held, other] = await Promise.all([
      tx.paymentIntent.count({ where: { valId } }),
      tx.paymentGatewayEvent.count({
        where: {
          valId,
          id: { not: eventId },
          kind: 'VALIDATE',
          reviewReason: { not: null },
          NOT: { review: { is: { outcome: 'DISMISSED' } } },
        },
      }),
    ]);
    return held > 0 || other > 0;
  }

  private async signalViews(rows: SignalRow[]): Promise<PaymentSignalItem[]> {
    const names = await staffNames(
      this.db.tx,
      rows.map((r) => r.review?.resolvedById).filter((v): v is string => !!v),
    );
    const out: PaymentSignalItem[] = [];
    for (const e of rows) {
      out.push({
        eventId: e.id,
        reason: e.reviewReason as 'UNMATCHED' | 'DUPLICATE',
        receivedAt: e.receivedAt.toISOString(),
        tranId: e.tranId,
        money: this.eventMoney(e),
        intent: e.intent
          ? { id: e.intent.id, tranId: e.intent.tranId, student: e.intent.student }
          : null,
        canDismiss: !e.review && (await this.isRepeat(e.id, e.valId)),
        decision: e.review
          ? {
              outcome: e.review.outcome as 'REFUNDED_OUTSIDE' | 'DISMISSED',
              at: e.review.resolvedAt.toISOString(),
              by: staffRef(names, e.review.resolvedById),
              note: e.review.note,
              amountPaisa: e.review.amountPaisa,
              refundReference: e.review.refundReference,
            }
          : null,
      });
    }
    return out;
  }

  // ───────────────────────────── Check now ─────────────────────────────

  /** POST /fees/online-payments/:id/check: a query by tran_id, in a job (once a minute). */
  async check(intentId: string): Promise<OnlinePaymentCheckQueued> {
    const intent = await this.db.tx.paymentIntent.findUnique({
      where: { id: intentId },
      select: { id: true },
    });
    if (!intent) throw new NotFoundException('Online payment not found');
    await this.limiter.consumeIfAllowed({ key: `pay-check:${intentId}`, limit: 1, windowSec: 60 });
    const tenantId = this.context.requireTenantId();
    const requestedAt = this.clock.now();
    await this.context.afterCommit(() =>
      this.reconcileQueue.queueStep({ tenantId, intentId, step: 'manual' }, requestedAt.getTime()),
    );
    return { requestedAt: requestedAt.toISOString() };
  }

  // ───────────────────────────── Decisions on intents ─────────────────────────────

  /** The intent under the tenant's fee lock, the student's lock and its row lock (404 if none). */
  private async lockIntent(intentId: string) {
    const tx = this.db.tx;
    const head = await tx.paymentIntent.findUnique({
      where: { id: intentId },
      select: { studentId: true },
    });
    if (!head) throw new NotFoundException('Online payment not found');
    await lockTenantFees(tx, 'shared');
    await lockStudentFees(tx, head.studentId);
    await lockPaymentIntent(tx, intentId);
    return tx.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
  }

  private alreadyResolved() {
    return apiError(409, 'ALREADY_RESOLVED', 'Someone has already decided about this payment');
  }

  /**
   * The gateway's payment day (P7b-F): SSLCommerz's tran_date in the institute's timezone, else
   * the day its validation was recorded; never before the checkout day nor after today.
   */
  private async gatewayDay(
    intent: { id: string; valId: string | null; gatewayPaidAt: Date | null; pricedOn: Date },
    timezone: string,
    today: IsoDate,
  ): Promise<IsoDate> {
    let at = intent.gatewayPaidAt;
    if (!at && intent.valId) {
      const first = await this.db.tx.paymentGatewayEvent.findFirst({
        where: { intentId: intent.id, kind: 'VALIDATE', valId: intent.valId },
        orderBy: { receivedAt: 'asc' },
        select: { receivedAt: true },
      });
      at = first?.receivedAt ?? null;
    }
    const pricedOn = dateFromDb(intent.pricedOn);
    const day = at ? todayIn(timezone, at) : today;
    return day < pricedOn ? pricedOn : day > today ? today : day;
  }

  /** POST /fees/online-payments/:id/apply (OWNER/ADMIN). */
  async apply(intentId: string, input: ApplyInput): Promise<FeeReceipt> {
    const tx = this.db.tx;
    const intent = await this.lockIntent(intentId);

    // A retry of a request that already succeeded gets the same receipt (under the locks), while
    // that payment stands: voided since (the intent back in review, or applied again by another
    // request), the retry is a conflict, never the voided receipt (review round 2, probe A).
    const previous = await tx.feePayment.findFirst({
      where: { clientRequestId: input.clientRequestId },
      select: { id: true, paymentIntentId: true, amountPaisa: true, status: true },
    });
    if (previous) {
      if (previous.paymentIntentId !== intent.id || previous.amountPaisa !== input.applyPaisa) {
        throw apiError(422, 'IDEMPOTENCY_MISMATCH', 'This request id was used for another payment');
      }
      if (
        previous.status !== 'ACTIVE' ||
        intent.status !== 'PAID' ||
        intent.feePaymentId !== previous.id
      ) {
        throw apiError(
          409,
          'PAYMENT_VOIDED',
          'The payment this request recorded was voided: reload the payment and decide again',
        );
      }
      return { ...(await this.collection.receipt(previous.id)), replayed: true };
    }
    if (intent.status !== 'NEEDS_REVIEW') throw this.alreadyResolved();
    const block = this.applyBlock(intent);
    if (block) throw apiError(block.status, block.code, block.message);
    // The money still to decide: what was already given back outside the app stays given back
    // (an applied payment voided back into review keeps its refunded part; P7b-N).
    const kept = intent.refundedOutsidePaisa ?? 0;
    const money = intent.validatedAmountPaisa! - kept;
    if (input.applyPaisa > money) {
      throw apiError(422, 'AMOUNT_EXCEEDS_MONEY', 'More than the money SSLCommerz confirmed', {
        moneyPaisa: money,
      });
    }
    // The same bank transaction already recorded as a live payment (a duplicate): never twice.
    const live = await tx.feePayment.findFirst({
      where: { status: 'ACTIVE', method: intent.method!, trxId: intent.bankTranId! },
      select: { id: true },
    });
    if (live) {
      throw apiError(409, 'TRX_ID_USED', 'This transaction is already recorded as a payment');
    }

    const ctx = await this.dues.planContext();
    await this.dues.ensureForStudents([intent.studentId], { ctx });
    const advanceIds = await this.dues.ensureAdvance(intent.studentId, input.advance, ctx);
    const rows = await this.collection.openDues(intent.studentId, [...input.dueIds, ...advanceIds]);
    const paidOn = await this.gatewayDay(intent, ctx.timezone, ctx.today);
    const outstanding = this.collection.outstanding(rows, paidOn);
    if (outstanding !== input.expectedOutstandingPaisa) {
      throw apiError(409, 'DUES_CHANGED', 'These dues changed: check the amount again', {
        outstandingPaisa: outstanding,
      });
    }
    if (input.applyPaisa > outstanding) {
      throw apiError(422, 'AMOUNT_EXCEEDS_DUE', 'More than these dues owe', {
        outstandingPaisa: outstanding,
      });
    }
    const remainder = money - input.applyPaisa;
    if (remainder > 0 && !input.refundOutside) {
      throw apiError(
        422,
        'REMAINDER_NEEDS_REFUND',
        'The rest of the money must be recorded as refunded outside the app',
        { remainderPaisa: remainder },
      );
    }
    const refunded = kept + remainder > 0 ? kept + remainder : null;
    // A new reference names this refund; otherwise the earlier one stays (never cleared).
    const reference =
      (remainder > 0 ? input.refundOutside?.reference : null) ?? intent.refundReference;

    const paymentId = await this.collection.recordPayment({
      studentId: intent.studentId,
      dues: rows,
      amountPaisa: input.applyPaisa,
      method: intent.method!,
      channel: 'GATEWAY',
      trxId: intent.bankTranId,
      senderPhone: null,
      paidOn,
      recordedOn: ctx.today,
      clientRequestId: input.clientRequestId,
      paymentIntentId: intent.id,
    });
    const me = this.context.requirePrincipal().userId;
    await tx.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: 'PAID',
        feePaymentId: paymentId,
        resolvedById: me,
        resolvedAt: this.clock.now(),
        resolutionNote: input.note,
        appliedPaisa: input.applyPaisa,
        refundedOutsidePaisa: refunded,
        refundReference: reference,
      },
      select: { id: true },
    });
    await this.audit.record({
      entity: INTENT,
      entityId: intent.id,
      action: 'UPDATE',
      oldValues: { status: intent.status, reasons: intent.reviewReasons },
      newValues: {
        status: 'PAID',
        action: 'APPLY',
        paymentId,
        validatedAmountPaisa: intent.validatedAmountPaisa,
        ...(kept > 0 ? { refundedBeforePaisa: kept } : {}),
        appliedPaisa: input.applyPaisa,
        refundedOutsidePaisa: refunded,
        reference,
        dueIds: input.dueIds,
        advance: input.advance,
        paidOn,
        note: input.note,
      },
    });
    return this.collection.receipt(paymentId);
  }

  /** POST /fees/online-payments/:id/refunded-outside (OWNER/ADMIN): final (P7b-N). */
  async refundOutside(intentId: string, input: RefundInput): Promise<OnlinePaymentStaffView> {
    const intent = await this.lockIntent(intentId);
    if (intent.status !== 'NEEDS_REVIEW') throw this.alreadyResolved();
    if (intent.valId === null) {
      throw apiError(
        422,
        'NO_MONEY',
        'No money was confirmed for this payment: dismiss it instead',
      );
    }
    // The whole money is then given back: what an earlier partial apply refunded (kept after
    // its void) and the rest now.
    const kept = intent.refundedOutsidePaisa;
    const reference = input.reference ?? intent.refundReference;
    await this.db.tx.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: 'REFUNDED_OUTSIDE',
        resolvedById: this.context.requirePrincipal().userId,
        resolvedAt: this.clock.now(),
        resolutionNote: input.note,
        refundedOutsidePaisa: intent.validatedAmountPaisa,
        refundReference: reference,
      },
      select: { id: true },
    });
    await this.audit.record({
      entity: INTENT,
      entityId: intent.id,
      action: 'UPDATE',
      oldValues: { status: intent.status, reasons: intent.reviewReasons },
      newValues: {
        status: 'REFUNDED_OUTSIDE',
        action: 'REFUND_OUTSIDE',
        refundedOutsidePaisa: intent.validatedAmountPaisa,
        ...(kept !== null && intent.validatedAmountPaisa !== null
          ? { refundedBeforePaisa: kept, restPaisa: intent.validatedAmountPaisa - kept }
          : {}),
        reference,
        note: input.note,
      },
    });
    return this.detail(intent.id);
  }

  /** POST /fees/online-payments/:id/dismiss (OWNER/ADMIN): only what holds no money. */
  async dismiss(intentId: string, input: DismissInput): Promise<OnlinePaymentStaffView> {
    const intent = await this.lockIntent(intentId);
    if (intent.status !== 'NEEDS_REVIEW') throw this.alreadyResolved();
    if (intent.valId !== null) {
      throw apiError(422, 'HAS_MONEY', 'This payment holds money: apply it or refund it outside');
    }
    if (!this.checkedClean(intent)) {
      throw apiError(
        409,
        'CHECK_FIRST',
        'Check with SSLCommerz first: a check in the last 15 minutes must have found nothing',
      );
    }
    const note = input.note;
    await this.db.tx.paymentIntent.update({
      where: { id: intent.id },
      data: {
        status: 'DISMISSED',
        resolvedById: this.context.requirePrincipal().userId,
        resolvedAt: this.clock.now(),
        resolutionNote: note,
      },
      select: { id: true },
    });
    await this.audit.record({
      entity: INTENT,
      entityId: intent.id,
      action: 'UPDATE',
      oldValues: { status: intent.status, reasons: intent.reviewReasons },
      newValues: {
        status: 'DISMISSED',
        action: 'DISMISS',
        lastCheckedAt: intent.lastCheckedAt?.toISOString() ?? null,
        note,
      },
    });
    return this.detail(intent.id);
  }

  // ───────────────────────────── Decisions on money items ─────────────────────────────

  /** The review event under its intent's locks (if any), then its money's (404 if not an item). */
  private async lockSignal(eventId: string) {
    const tx = this.db.tx;
    const event = await tx.paymentGatewayEvent.findFirst({
      where: { id: eventId, kind: 'VALIDATE', reviewReason: { not: null } },
      select: { id: true, intentId: true, valId: true },
    });
    if (!event) throw new NotFoundException('Item not found');
    await lockTenantFees(tx, 'shared');
    if (event.intentId) {
      const intent = await tx.paymentIntent.findUniqueOrThrow({
        where: { id: event.intentId },
        select: { studentId: true },
      });
      await lockStudentFees(tx, intent.studentId);
      await lockPaymentIntent(tx, event.intentId);
    }
    if (event.valId) await lockPaymentMoney(tx, event.valId);
    else await lockPaymentSignals(tx);
    return tx.paymentGatewayEvent.findUniqueOrThrow({
      where: { id: eventId },
      include: signalInclude,
    });
  }

  private async decideSignal(
    eventId: string,
    outcome: 'REFUNDED_OUTSIDE' | 'DISMISSED',
    note: string,
    reference: string | null,
  ): Promise<PaymentSignalItem> {
    const tx = this.db.tx;
    const event = await this.lockSignal(eventId);
    if (event.review) throw this.alreadyResolved();
    // Money is refunded outside once (review round 1, finding 2), under its val_id's lock: never
    // a second record of money already refunded, nor money an online payment of ours holds (that
    // is decided on the payment). The database checks the same at commit.
    if (outcome === 'REFUNDED_OUTSIDE' && event.valId) {
      const [held, refunded] = await Promise.all([
        tx.paymentIntent.count({ where: { valId: event.valId } }),
        tx.paymentGatewayEvent.count({
          where: {
            valId: event.valId,
            id: { not: event.id },
            review: { is: { outcome: 'REFUNDED_OUTSIDE' } },
          },
        }),
      ]);
      if (held > 0) {
        throw apiError(
          409,
          'HELD_BY_PAYMENT',
          "This money is an online payment's own: decide it on that payment",
        );
      }
      if (refunded > 0) {
        throw apiError(
          409,
          'ALREADY_REFUNDED',
          'This money is already recorded as refunded outside: dismiss this record as a repeat',
        );
      }
    }
    if (outcome === 'DISMISSED' && !(await this.isRepeat(event.id, event.valId))) {
      throw apiError(
        422,
        'HAS_MONEY',
        'This is the only record of this money: refund it outside, never dismiss it',
      );
    }
    const amount = outcome === 'REFUNDED_OUTSIDE' ? this.eventMoney(event).amountPaisa : null;
    const resolvedAt = this.clock.now();
    await tx.paymentSignalReview.create({
      data: {
        tenantId: this.context.requireTenantId(),
        eventId: event.id,
        outcome,
        amountPaisa: amount !== null && amount >= 1 ? amount : null,
        refundReference: reference,
        note,
        resolvedById: this.context.requirePrincipal().userId,
        resolvedAt,
      },
      select: { id: true },
    });
    await this.audit.record({
      entity: SIGNAL,
      entityId: event.id,
      action: 'CREATE',
      newValues: {
        outcome,
        reason: event.reviewReason,
        valId: event.valId,
        amountPaisa: amount,
        reference,
        note,
      },
    });
    const fresh = await tx.paymentGatewayEvent.findUniqueOrThrow({
      where: { id: event.id },
      include: signalInclude,
    });
    const [item] = await this.signalViews([fresh]);
    return item!;
  }

  /** POST /fees/online-payments/signals/:eventId/refunded-outside (OWNER/ADMIN). */
  signalRefundOutside(eventId: string, input: RefundInput): Promise<PaymentSignalItem> {
    return this.decideSignal(eventId, 'REFUNDED_OUTSIDE', input.note, input.reference);
  }

  /** POST /fees/online-payments/signals/:eventId/dismiss (OWNER/ADMIN): a repeat record only. */
  signalDismiss(eventId: string, input: DismissInput): Promise<PaymentSignalItem> {
    return this.decideSignal(eventId, 'DISMISSED', input.note, null);
  }
}

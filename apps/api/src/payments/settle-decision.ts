import {
  isWellFormedBankTranId,
  type PaymentIntentStatus,
  type PaymentReviewReason,
} from '@jantrik/shared';

/**
 * The money facts of one payment as SSLCommerz's validation API reported them (the PAID outcome
 * of `PaymentProvider.confirm`), the part the decision needs.
 */
export interface PaidFacts {
  valId: string;
  /** As the gateway returned it; compared with ours. */
  tranId: string | null;
  amountPaisa: number | null;
  currency: string | null;
  currencyType: string | null;
  currencyAmountPaisa: number | null;
  bankTranId: string | null;
  risk: 'LOW' | 'HIGH';
}

/** What `settle` needs to know of the intent, read under its row lock. */
export interface IntentState {
  status: PaymentIntentStatus;
  tranId: string;
  amountPaisa: number;
  /** The validation ID whose money the intent already holds, if any. */
  valId: string | null;
}

export type SettleDecision =
  /** A repeat signal for the money the intent already holds. */
  | { kind: 'NOTHING' }
  /** The VALIDATE event is the only record (DUPLICATE: money received twice, for P7b's queue). */
  | { kind: 'EVENT_ONLY'; eventReason: 'DUPLICATE' | 'UNMATCHED' | null }
  /** NEEDS_REVIEW (or stays there) with these reasons; the money facts recorded when asked. */
  | {
      kind: 'REVIEW';
      recordFacts: boolean;
      addReasons: PaymentReviewReason[];
      eventReason: 'UNMATCHED' | null;
    }
  /** Every check passed: record the payment and its receipt. */
  | { kind: 'POST' };

const OPEN: readonly PaymentIntentStatus[] = ['CREATED', 'REDIRECTED'];
const CLOSED_UNPAID: readonly PaymentIntentStatus[] = [
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'DISMISSED',
];
const HOLDS_MONEY: readonly PaymentIntentStatus[] = ['PAID', 'REFUNDED_OUTSIDE'];

/**
 * What keeps validated money from posting on an open intent (S23), in the enum's order: a
 * missing or malformed bank_tran_id, a currency other than BDT (settlement or sent), an amount
 * other than the intent's (the paid amount or the one we sent; unparseable included), anything
 * but low risk, and dues that changed since the amount was set.
 */
export function mismatchReasons(
  intent: IntentState,
  paid: PaidFacts,
  duesChanged: boolean,
): PaymentReviewReason[] {
  const reasons: PaymentReviewReason[] = [];
  if (paid.amountPaisa !== intent.amountPaisa || paid.currencyAmountPaisa !== intent.amountPaisa) {
    reasons.push('AMOUNT_MISMATCH');
  }
  if (paid.currency !== 'BDT' || paid.currencyType !== 'BDT') reasons.push('CURRENCY_MISMATCH');
  if (!isWellFormedBankTranId(paid.bankTranId)) reasons.push('TRAN_ID_MISMATCH');
  if (paid.risk !== 'LOW') reasons.push('HIGH_RISK');
  if (duesChanged) reasons.push('DUES_CHANGED');
  return reasons;
}

/**
 * The decision table (docs/payments.md → settle). Called under the student's lock and the intent's
 * row lock, so one decision is made at a time per intent. Only one outcome posts: an open intent
 * whose validated money matches it exactly.
 *
 * - `otherIntent`: another intent of this institute has the tran_id the gateway returned (that
 *   money is handled through its own signals); otherwise such money is UNMATCHED.
 * - `duplicate`: a run before this one tried to post and the database refused it as a duplicate
 *   (the bank_tran_id already on a live payment): review instead.
 * - `forgeable`: the val_id came only from signals anyone with the tran_id can send (a return, or
 *   an IPN from an address SSLCommerz does not list), not from its listed address or our query.
 * - `refundedAsItem`: this money (its val_id) was already recorded as refunded outside on a money
 *   item (P7b): it is never this intent's too (review round 2, probe E).
 */
export function decideSettlement(
  intent: IntentState,
  paid: PaidFacts,
  opts: {
    duesChanged: boolean;
    otherIntent?: boolean;
    duplicate?: boolean;
    forgeable?: boolean;
    refundedAsItem?: boolean;
  },
): SettleDecision {
  // First, whose money is it? Another tran_id's money is never recorded on this intent (P7a-H).
  if (paid.tranId !== intent.tranId) {
    const eventReason = opts.otherIntent ? null : 'UNMATCHED';
    // Brought only by forgeable signals: the event is the record (UNMATCHED, for P7b's queue, when
    // no intent of ours has that tran_id) and this payment stays as it is, so a stranger's val_id
    // cannot keep a guardian's genuine payment from posting (P7a2-x30, narrowing P7a-H).
    if (opts.forgeable || HOLDS_MONEY.includes(intent.status)) {
      return { kind: 'EVENT_ONLY', eventReason };
    }
    return { kind: 'REVIEW', recordFacts: false, addReasons: ['TRAN_ID_MISMATCH'], eventReason };
  }
  if (intent.valId === paid.valId) return { kind: 'NOTHING' };
  // Money the intent already holds came from another validation: this is a second payment.
  if (intent.valId !== null || HOLDS_MONEY.includes(intent.status)) {
    return { kind: 'EVENT_ONLY', eventReason: 'DUPLICATE' };
  }
  // Money already given back outside the app as a money item (SSLCommerz once named no payment of
  // ours for it): never posted, never held here as well (the database refuses it); the payment
  // waits for a person, as money received twice.
  if (opts.refundedAsItem) {
    return {
      kind: 'REVIEW',
      recordFacts: false,
      addReasons: CLOSED_UNPAID.includes(intent.status)
        ? ['LATE_SUCCESS', 'DUPLICATE']
        : ['DUPLICATE'],
      eventReason: null,
    };
  }
  const reasons = mismatchReasons(intent, paid, opts.duesChanged);
  if (intent.status === 'NEEDS_REVIEW') {
    // Never posted by a signal: the money is recorded for the person who reviews it.
    return { kind: 'REVIEW', recordFacts: true, addReasons: reasons, eventReason: null };
  }
  if (CLOSED_UNPAID.includes(intent.status)) {
    return {
      kind: 'REVIEW',
      recordFacts: true,
      addReasons: ['LATE_SUCCESS', ...reasons],
      eventReason: null,
    };
  }
  if (!OPEN.includes(intent.status)) {
    // Not reachable with today's states; never post in doubt.
    return { kind: 'EVENT_ONLY', eventReason: 'DUPLICATE' };
  }
  if (reasons.length > 0) {
    return { kind: 'REVIEW', recordFacts: true, addReasons: reasons, eventReason: null };
  }
  if (opts.duplicate) {
    return { kind: 'REVIEW', recordFacts: true, addReasons: ['DUPLICATE'], eventReason: null };
  }
  return { kind: 'POST' };
}

import { z } from 'zod';
import type { IsoDate } from './dates.js';
import { isoDateSchema } from './dates-schema.js';
import type { FeeStudentRef } from './fees-api.js';
import type { FeePaymentMethod } from './fees.js';

// Online payments API (sprint 1 P7a, docs/payments.md): what the web app and the API exchange.

export const PAYMENT_PROVIDERS = ['SSLCOMMERZ'] as const;
export type PaymentProviderKey = (typeof PAYMENT_PROVIDERS)[number];

/** The result of an account's connection test (P7a-M). */
export const GATEWAY_TEST_RESULTS = [
  'OK',
  'BAD_CREDENTIALS',
  'STORE_INACTIVE',
  'UNREACHABLE',
  'ERROR',
] as const;
export type GatewayTestResult = (typeof GATEWAY_TEST_RESULTS)[number];

/** Store IDs are letters, digits, `_` and `-` (the hint keeps the last 4). */
export const SSLCOMMERZ_STORE_ID_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;
/** Printable ASCII without spaces, at most 100 characters. */
const STORE_PASSWORD_PATTERN = /^[\x21-\x7e]{1,100}$/;

/**
 * An SSLCommerz store's credentials as the owner enters them (write-only: never sent back). The
 * messages never repeat what was typed.
 */
export const sslcommerzCredentialsSchema = z.strictObject({
  storeId: z
    .string()
    .trim()
    .regex(SSLCOMMERZ_STORE_ID_PATTERN, 'Store ID: 1 to 50 letters, digits, _ or -'),
  storePassword: z
    .string()
    .regex(STORE_PASSWORD_PATTERN, 'Store password: 1 to 100 characters, no spaces'),
});
export type SslcommerzCredentials = z.output<typeof sslcommerzCredentialsSchema>;

/** The OWNER's view of the institute's gateway account. No credential, ever. */
export interface GatewayAccountView {
  provider: PaymentProviderKey;
  mode: 'SANDBOX';
  /** Credentials are saved. */
  configured: boolean;
  enabled: boolean;
  /** The store ID's last 4 characters (ASCII, `formatIdentifier`). */
  hint: string | null;
  credentialsUpdatedAt: string | null;
  lastTest: { at: string; result: GatewayTestResult } | null;
  /** The last failure of a job that used the account: a fixed code. */
  lastFailure: { at: string; code: string } | null;
  /**
   * What to paste into the SSLCommerz panel as the IPN address; null while the server has no
   * public address (API_PUBLIC_URL), when the account cannot be turned on.
   */
  ipnUrl: string | null;
}

/** POST …/account/test answers 202 with this; the result arrives on the view (`lastTest`). */
export interface GatewayTestQueued {
  requestedAt: string;
}

// ───────────────────────────── Checkout to receipt (P7a2) ─────────────────────────────

/** An online payment attempt (`payment_intents.status`; docs/payments.md → States). */
export const PAYMENT_INTENT_STATUSES = [
  'CREATED',
  'REDIRECTED',
  'PAID',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'NEEDS_REVIEW',
  /** P7b's outcomes of a review (created now, written by nothing in P7a). */
  'REFUNDED_OUTSIDE',
  'DISMISSED',
] as const;
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

/** Why an intent (or a gateway event) waits for a person (S23); never shown to guardians. */
export const PAYMENT_REVIEW_REASONS = [
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'TRAN_ID_MISMATCH',
  'HIGH_RISK',
  'DUES_CHANGED',
  'LATE_SUCCESS',
  'DUPLICATE',
  'UNMATCHED',
  /** A posted gateway payment was voided by an admin (P7a-G). */
  'VOIDED',
] as const;
export type PaymentReviewReason = (typeof PAYMENT_REVIEW_REASONS)[number];

/**
 * What a guardian may know of an online payment: PREPARING (the session is being made), READY
 * (go to the gateway), CONFIRMING (back from the gateway, asking it), PAID, CHECKING (the school
 * checks it: do not pay again), NOT_PAID, EXPIRED, REFUNDED.
 */
export const ONLINE_PAYMENT_STATES = [
  'PREPARING',
  'READY',
  'CONFIRMING',
  'PAID',
  'CHECKING',
  'NOT_PAID',
  'EXPIRED',
  'REFUNDED',
] as const;
export type OnlinePaymentState = (typeof ONLINE_PAYMENT_STATES)[number];

/** The guardian's state of an intent; `signalled`: a return or IPN has arrived for it. */
export function onlinePaymentState(
  status: PaymentIntentStatus,
  signalled: boolean,
): OnlinePaymentState {
  switch (status) {
    case 'CREATED':
      return 'PREPARING';
    case 'REDIRECTED':
      return signalled ? 'CONFIRMING' : 'READY';
    case 'PAID':
      return 'PAID';
    case 'NEEDS_REVIEW':
      return 'CHECKING';
    case 'FAILED':
    case 'CANCELLED':
    case 'DISMISSED':
      return 'NOT_PAID';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'REFUNDED_OUTSIDE':
      return 'REFUNDED';
  }
}

/**
 * POST /me/children/:id/fees/online-payments (S22): the dues to pay in full, never an amount. The
 * server computes it; `expectedAmountPaisa` is what the guardian was shown (409 DUES_CHANGED with
 * the real amount when it moved). `clientRequestId` is new for every attempt (a retry returns the
 * same payment).
 */
export const startOnlinePaymentSchema = z.strictObject({
  dueIds: z
    .array(z.uuid())
    .min(1)
    .max(24)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Each due once' }),
  expectedAmountPaisa: z.number().int().min(0).max(1_000_000_000),
  clientRequestId: z.uuid(),
});
export type StartOnlinePaymentInput = z.input<typeof startOnlinePaymentSchema>;

/** One due an online payment pays, with what it owed when the amount was set (the snapshot). */
export interface OnlinePaymentDue {
  id: string;
  head: { nameBn: string; nameEn: string };
  periodKey: string;
  term: { nameBn: string; nameEn: string } | null;
  principalPaisa: number;
  finePaisa: number;
}

/** GET /me/children/:id/fees/online-payments/:intentId (and the checkout's answer). */
export interface OnlinePaymentView {
  id: string;
  state: OnlinePaymentState;
  amountPaisa: number;
  dues: OnlinePaymentDue[];
  createdAt: string;
  /** Our transaction ID (ASCII), as the gateway shows it. */
  tranId: string;
  /** The gateway's payment page: only for the guardian who started it, while it is READY. */
  checkoutUrl?: string;
  /** PAID: the receipt. */
  receipt?: { id: string; receiptNumber: string };
  /** The one who started it is the caller. */
  mine: boolean;
  /**
   * In progress at the gateway (READY or CONFIRMING), and our own query by tran_id, asked since
   * the last return or IPN, listed no paid or pending attempt: its payer may start again from
   * "confirming" (P7a2-x31). False otherwise, and while a signal is not yet answered for.
   */
  noLiveAttempt: boolean;
}

// ─────────────────── Reconciliation and the review queue (P7b, docs/payments.md) ───────────────────

/** "Dismiss" needs a check this recent that found no success (P7b-E). */
export const DISMISS_CHECK_MINUTES = 15;

/** What the institute's own records call a refund made outside the app (ASCII). */
export const REFUND_REFERENCE_PATTERN = /^[A-Za-z0-9._/-]{1,100}$/;

/** Every decision says why (3 to 500 characters). */
const reviewNoteSchema = z.string().trim().min(3).max(500);
const refundReferenceSchema = z
  .string()
  .trim()
  .max(100)
  .nullish()
  .transform((v) => v || null)
  .refine((v) => v === null || REFUND_REFERENCE_PATTERN.test(v), {
    message: 'Reference: letters, digits and - _ . / only',
  });

/**
 * POST /fees/online-payments/:id/apply (OWNER/ADMIN): the validated money of an intent in review
 * applied to chosen dues of its child (and periods paid ahead), as one gateway payment. Less than
 * the money needs `refundOutside`: the rest was given back outside the app (P7b-E); `note` says
 * why, for both. `expectedOutstandingPaisa` is what the chosen dues owed as shown (409
 * DUES_CHANGED when it moved); `clientRequestId` is new for every attempt.
 */
export const applyOnlinePaymentSchema = z
  .strictObject({
    dueIds: z.array(z.uuid()).max(60).default([]),
    advance: z
      .array(z.strictObject({ headId: z.uuid(), periodKey: z.string().min(1).max(60) }))
      .max(24)
      .default([]),
    applyPaisa: z.number().int().min(1).max(1_000_000_000),
    expectedOutstandingPaisa: z.number().int().min(0).max(1_000_000_000),
    refundOutside: z.strictObject({ reference: refundReferenceSchema }).optional(),
    note: reviewNoteSchema,
    clientRequestId: z.uuid(),
  })
  .refine((c) => c.dueIds.length + c.advance.length > 0, {
    message: 'Choose at least one due',
    path: ['dueIds'],
  });
export type ApplyOnlinePaymentInput = z.input<typeof applyOnlinePaymentSchema>;

/** POST …/refunded-outside (an intent or a signal item): the whole money given back outside. */
export const refundedOutsideSchema = z.strictObject({
  note: reviewNoteSchema,
  reference: refundReferenceSchema,
});
export type RefundedOutsideInput = z.input<typeof refundedOutsideSchema>;

/** POST …/dismiss: an item that holds no money (or a repeat record of money held elsewhere). */
export const dismissReviewSchema = z.strictObject({ note: reviewNoteSchema });
export type DismissReviewInput = z.input<typeof dismissReviewSchema>;

/** GET /fees/online-payments: newest first, 50 a page. */
export const onlinePaymentsQuerySchema = z
  .object({
    status: z.enum(PAYMENT_INTENT_STATUSES).optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    /** Our tran_id, the gateway's bank_tran_id or the student's ID (exact, ASCII). */
    q: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
  })
  .refine((v) => !v.from || !v.to || v.to >= v.from, {
    message: 'The end is before the start',
    path: ['to'],
  });
export const ONLINE_PAYMENTS_PAGE_SIZE = 50;

/** The money SSLCommerz validated for an intent (or a review event), as recorded. */
export interface OnlineMoneyView {
  valId: string | null;
  /** ASCII identifier (formatIdentifier). */
  bankTranId: string | null;
  method: FeePaymentMethod | null;
  /** SSLCommerz's card_type, e.g. "BKASH-BKash". */
  instrument: string | null;
  /** Null when the gateway's amount was not a well-formed amount. */
  amountPaisa: number | null;
  storeAmountPaisa: number | null;
  currency: string | null;
  risk: 'LOW' | 'HIGH' | null;
  paidAt: string | null;
}

/** A staff member as the institute knows them. */
export interface PaymentStaffRef {
  id: string;
  name: string;
  nameBn: string | null;
}

/** A person's decision on an intent in review (cleared when it comes back to review). */
export interface OnlinePaymentDecision {
  outcome: 'APPLIED' | 'REFUNDED_OUTSIDE' | 'DISMISSED';
  at: string;
  by: PaymentStaffRef | null;
  note: string;
  appliedPaisa: number | null;
  refundedOutsidePaisa: number | null;
  refundReference: string | null;
}

/** One of the intent's dues: what it owed at checkout, and what it owes today. */
export interface OnlinePaymentDueStaff extends OnlinePaymentDue {
  now: { status: string; principalPaisa: number; finePaisa: number; totalPaisa: number };
}

/** What may be done with an intent now (OWNER/ADMIN; the server checks again). */
export interface OnlinePaymentActions {
  apply: boolean;
  refundOutside: boolean;
  /** Holds no money; still needs a check in the last 15 minutes that found nothing. */
  dismiss: boolean;
  /** A check in the last 15 minutes found no success. */
  dismissReady: boolean;
}

export interface OnlinePaymentEventView {
  id: string;
  kind: 'INIT' | 'RETURN' | 'IPN' | 'VALIDATE' | 'QUERY';
  outcome: string | null;
  receivedAt: string;
  valId: string | null;
  tranId: string | null;
  reviewReason: 'UNMATCHED' | 'DUPLICATE' | null;
  fields: Partial<Record<string, string>>;
}

/** GET /fees/online-payments/:id and the queue's intent items (OWNER, ADMIN, ACCOUNTANT). */
export interface OnlinePaymentStaffView {
  id: string;
  tranId: string;
  status: PaymentIntentStatus;
  reasons: PaymentReviewReason[];
  reviewSince: string | null;
  createdAt: string;
  closedAt: string | null;
  pricedOn: IsoDate;
  /** What we asked for (the dues in full on the checkout day). */
  amountPaisa: number;
  money: OnlineMoneyView | null;
  student: FeeStudentRef & { classLevel: { nameBn: string; nameEn: string } | null };
  /** The guardian who paid, as the institute recorded them. */
  payer: { nameBn: string | null; nameEn: string | null } | null;
  dues: OnlinePaymentDueStaff[];
  lastCheck: { at: string; outcome: string } | null;
  decision: OnlinePaymentDecision | null;
  /**
   * Money already given back outside the app: with an applied intent, its refunded part; it stays
   * after a void brings the intent back to review (P7b-N), and only the rest may then be applied
   * or refunded.
   */
  refundedOutside: { amountPaisa: number; reference: string | null } | null;
  /** Its live payment (PAID). */
  payment: { id: string; receiptNumber: string } | null;
  actions: OnlinePaymentActions;
  /** The detail only: everything the gateway told us or we asked it (whitelisted fields). */
  events?: OnlinePaymentEventView[];
}

export interface OnlinePaymentListRow {
  id: string;
  tranId: string;
  status: PaymentIntentStatus;
  reasons: PaymentReviewReason[];
  amountPaisa: number;
  method: FeePaymentMethod | null;
  bankTranId: string | null;
  createdAt: string;
  student: FeeStudentRef;
  receiptNumber: string | null;
  lastCheck: { at: string; outcome: string } | null;
}

export interface OnlinePaymentList {
  rows: OnlinePaymentListRow[];
  page: number;
  pageSize: number;
  total: number;
}

/** A decision on a signal item (refunded outside, or dismissed as a repeat record). */
export interface PaymentSignalDecision {
  outcome: 'REFUNDED_OUTSIDE' | 'DISMISSED';
  at: string;
  by: PaymentStaffRef | null;
  note: string;
  amountPaisa: number | null;
  refundReference: string | null;
}

/**
 * Money no intent of ours holds (UNMATCHED: paid to the institute's store under a tran_id we never
 * made) or that came twice (DUPLICATE). Never applied to dues (P7b-H): refunded outside, or
 * dismissed when it is a repeat record of money held elsewhere (`canDismiss`).
 */
export interface PaymentSignalItem {
  eventId: string;
  reason: 'UNMATCHED' | 'DUPLICATE';
  receivedAt: string;
  tranId: string | null;
  money: OnlineMoneyView;
  intent: { id: string; tranId: string; student: FeeStudentRef } | null;
  canDismiss: boolean;
  decision: PaymentSignalDecision | null;
}

/** GET /fees/online-payments/review: oldest first. */
export interface PaymentReviewQueue {
  intents: OnlinePaymentStaffView[];
  signals: PaymentSignalItem[];
  /** Unmatched IPNs SSLCommerz said were not this store's payments (30 days; not items). */
  checked: { eventId: string; receivedAt: string; tranId: string | null; valId: string | null }[];
  count: number;
}

/** POST /fees/online-payments/:id/check: 202; the answer arrives on the view's lastCheck. */
export interface OnlinePaymentCheckQueued {
  requestedAt: string;
}

/** GET /fees/reports/online-payments (and …/csv): by the day each payment was started. */
export const onlinePaymentsReportQuerySchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    locale: z.enum(['bn', 'en']).default('bn'),
  })
  .refine((q) => q.to >= q.from, { message: 'The end is before the start', path: ['to'] })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 366 * 86_400_000, {
    message: 'At most a year',
    path: ['to'],
  });

export interface OnlinePaymentsReportRow {
  /** The day the payments were started (the institute's timezone). */
  day: IsoDate;
  /** Every payment started that day, with what was asked. */
  initiated: { count: number; amountPaisa: number };
  /** Still at the gateway (CREATED, REDIRECTED). */
  open: { count: number };
  /** PAID now, with the amount of each payment (an applied one: what was applied). */
  paid: { count: number; amountPaisa: number };
  /** FAILED or CANCELLED. */
  failed: { count: number };
  expired: { count: number };
  /** In review now, with the money SSLCommerz validated for them. */
  review: { count: number; amountPaisa: number };
  /** Given back outside the app (whole, or the rest of an applied payment). */
  refundedOutside: { count: number; amountPaisa: number };
  dismissed: { count: number };
  /**
   * All the money SSLCommerz validated for them, whatever happened since: the amount, the
   * store's share and SSLCommerz's charges (amount − store amount, where both are known; S24).
   */
  received: { amountPaisa: number; storeAmountPaisa: number; chargesPaisa: number };
}

export interface OnlinePaymentsReport {
  from: IsoDate;
  to: IsoDate;
  rows: OnlinePaymentsReportRow[];
  total: Omit<OnlinePaymentsReportRow, 'day'>;
}

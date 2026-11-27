import { z } from 'zod';

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
}

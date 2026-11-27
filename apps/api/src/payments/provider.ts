import type { GatewayTestResult, SslcommerzCredentials } from '@jantrik/shared';
import type { ZodType } from 'zod';

/**
 * An online payment gateway (sprint 1 P7a, docs/payments.md → The client). One implementation
 * today, `SslcommerzProvider`; bKash tokenized later, as an institute setting. A provider never
 * throws for what the gateway did or did not answer: every failure is a fixed `ProviderErrorCode`,
 * so no body, header, URL or credential can reach a log line, a job's failure or a response.
 * Nothing it returns is trusted on its own: the caller compares it with its own records.
 */
export interface PaymentProvider {
  readonly key: 'SSLCOMMERZ';
  /** What the owner enters (write-only): checked before anything is encrypted. */
  readonly credentialsSchema: ZodType<SslcommerzCredentials>;
  /** Whether the gateway accepts these credentials (a query for a transaction that never existed). */
  testConnection(creds: SslcommerzCredentials): Promise<GatewayTestResult>;
  /** A hosted checkout session for one payment intent. */
  createCheckout(creds: SslcommerzCredentials, intent: CheckoutRequest): Promise<CheckoutResult>;
  /** The gateway's own word on one payment, by its validation ID (the Order Validation API). */
  confirm(
    creds: SslcommerzCredentials,
    ref: { tranId: string; valId: string },
  ): Promise<ProviderOutcome>;
  /** Every attempt the gateway knows for our transaction ID (the Transaction Query API). */
  query(creds: SslcommerzCredentials, tranId: string): Promise<ProviderAttempt[] | ProviderError>;
}

export const PROVIDER_ERROR_CODES = [
  /** No answer within the timeout (30 s). */
  'TIMEOUT',
  /** The request never got an answer (DNS, connection, TLS). */
  'NETWORK',
  /** An answer that was not 2xx (a redirect included: it is never followed). */
  'HTTP_STATUS',
  /** An answer that was not the documented JSON, or a field missing or malformed. */
  'BAD_RESPONSE',
  /** The gateway refused the credentials. */
  'AUTH_FAILED',
  /** The store is not active at the gateway. */
  'STORE_INACTIVE',
  /** The gateway refused the request itself. */
  'INVALID_REQUEST',
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export interface ProviderError {
  kind: 'ERROR';
  code: ProviderErrorCode;
}

export interface CheckoutRequest {
  /** Ours (`newTranId`), never reused. */
  tranId: string;
  /** Integer paisa, already within ONLINE_MIN_PAISA..ONLINE_MAX_PAISA. */
  amountPaisa: number;
  /** The intent's id, sent back unchanged by the gateway (support only, never trusted). */
  intentId: string;
  urls: { success: string; fail: string; cancel: string; ipn: string };
  /** The payer (P7a-K): the guardian, never the child. */
  customer: {
    name: string;
    phone: string;
    email: string;
    address: string;
    city: string;
    postcode: string;
    country: string;
  };
}

export type CheckoutResult =
  { kind: 'OK'; redirectUrl: string; sessionRef: string } | ProviderError;

/** The money facts of one validated or queried payment, each as the gateway reported it. */
export interface PaymentFacts {
  /** As the gateway returned it (compared with ours by the caller). */
  tranId: string | null;
  valId: string | null;
  /** `amount`; null when it is not a well-formed amount (never read through a float). */
  amountPaisa: number | null;
  /** `currency`: the settlement currency. */
  currency: string | null;
  /** `currency_type`: what the merchant sent. */
  currencyType: string | null;
  /** `currency_amount`. */
  currencyAmountPaisa: number | null;
  storeAmountPaisa: number | null;
  bankTranId: string | null;
  /** `card_type` (e.g. `BKASH-BKash`). */
  instrument: string | null;
  cardBrand: string | null;
  /** LOW only for `risk_level` "0"; anything else, missing included, HIGH. */
  risk: 'LOW' | 'HIGH';
  /** `tran_date`, read as Asia/Dhaka; shown only. */
  paidAt: Date | null;
}

export type ProviderOutcome =
  /** VALID or VALIDATED (validated more than once). */
  | ({ kind: 'PAID'; valId: string; repeated: boolean } & Omit<PaymentFacts, 'valId'>)
  | { kind: 'PENDING' }
  | { kind: 'FAILED' | 'CANCELLED' | 'EXPIRED' }
  /** INVALID_TRANSACTION: not a payment of this store. */
  | { kind: 'INVALID' }
  | ProviderError;

export const ATTEMPT_STATUSES = [
  'VALID',
  'VALIDATED',
  'PENDING',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'UNATTEMPTED',
  /** A status the documentation does not list: treated as nothing paid. */
  'OTHER',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** One attempt the Transaction Query API lists for a transaction ID. */
export interface ProviderAttempt extends PaymentFacts {
  status: AttemptStatus;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

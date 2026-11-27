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

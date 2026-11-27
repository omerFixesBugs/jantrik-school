import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

/**
 * The payments module's settings, read once from the environment (docs/payments.md →
 * Environment). The API tests replace them (test/support/harness.ts: the fake SSLCommerz's
 * address, a public address or none).
 */
export interface PaymentsConfig {
  /** API_PUBLIC_URL: the base of the return and IPN addresses; null when unset. */
  apiPublicUrl: string | null;
  /**
   * WEB_PUBLIC_URL (no trailing slash): where the payer's browser is sent back to (the payment's
   * page); null when unset, when nobody can start a checkout.
   */
  webPublicUrl: string | null;
  /** SSLCommerz's sandbox, or SSLCOMMERZ_BASE_URL (a fake; development and tests only). */
  sslcommerzBaseUrl: string;
  /** Every SSLCommerz call gives up after this long. */
  timeoutMs: number;
}

export const PAYMENTS_CONFIG = Symbol('PAYMENTS_CONFIG');

/** SSLCommerz's sandbox. The live host (securepay.sslcommerz.com) is a later decision. */
export const SSLCOMMERZ_SANDBOX_URL = 'https://sandbox.sslcommerz.com';

export const SSLCOMMERZ_TIMEOUT_MS = 30_000;

export function paymentsConfig(config: ConfigService<Env, true>): PaymentsConfig {
  return {
    apiPublicUrl: config.get('API_PUBLIC_URL', { infer: true }) ?? null,
    webPublicUrl: config.get('WEB_PUBLIC_URL', { infer: true })?.replace(/\/+$/, '') ?? null,
    // env.ts accepts the override only outside production, and only for this machine.
    sslcommerzBaseUrl: config.get('SSLCOMMERZ_BASE_URL', { infer: true }) ?? SSLCOMMERZ_SANDBOX_URL,
    timeoutMs: SSLCOMMERZ_TIMEOUT_MS,
  };
}

/** The address SSLCommerz posts an institute's notifications to (the owner pastes it). */
export const ipnUrl = (apiPublicUrl: string, slug: string): string =>
  `${apiPublicUrl}/public/payments/sslcommerz/${encodeURIComponent(slug)}/ipn`;

/** Where SSLCommerz sends the payer's browser back to, for one outcome (a hint only). */
export const returnUrl = (
  apiPublicUrl: string,
  slug: string,
  tranId: string,
  outcome: 'success' | 'fail' | 'cancel',
): string =>
  `${apiPublicUrl}/public/payments/sslcommerz/${encodeURIComponent(slug)}/return/${tranId}/${outcome}`;

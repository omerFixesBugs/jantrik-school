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
    // env.ts accepts the override only outside production, and only for this machine.
    sslcommerzBaseUrl: config.get('SSLCOMMERZ_BASE_URL', { infer: true }) ?? SSLCOMMERZ_SANDBOX_URL,
    timeoutMs: SSLCOMMERZ_TIMEOUT_MS,
  };
}

/** The address SSLCommerz posts an institute's notifications to (the owner pastes it). */
export const ipnUrl = (apiPublicUrl: string, slug: string): string =>
  `${apiPublicUrl}/public/payments/sslcommerz/${encodeURIComponent(slug)}/ipn`;

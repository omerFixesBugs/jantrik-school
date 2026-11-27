import { Inject, Injectable } from '@nestjs/common';
import {
  formatGatewayAmount,
  newTranId,
  sslcommerzCredentialsSchema,
  type GatewayTestResult,
  type SslcommerzCredentials,
} from '@jantrik/shared';
import type { z } from 'zod';
import {
  PAYMENTS_CONFIG,
  SSLCOMMERZ_SANDBOX_URL,
  type PaymentsConfig,
} from '../payments.config.js';
import type {
  CheckoutRequest,
  CheckoutResult,
  PaymentProvider,
  ProviderAttempt,
  ProviderError,
  ProviderErrorCode,
  ProviderOutcome,
} from '../provider.js';
import {
  attemptStatus,
  paymentFacts,
  queryAnswerSchema,
  sessionAnswerSchema,
  validationAnswerSchema,
} from './sslcommerz.schemas.js';

const SESSION_PATH = '/gwprocess/v4/api.php';
const VALIDATION_PATH = '/validator/api/validationserverAPI.php';
const QUERY_PATH = '/validator/api/merchantTransIDvalidationAPI.php';

/** The most of an answer read; SSLCommerz's are a few kilobytes. */
const MAX_ANSWER_BYTES = 256 * 1024;

const error = (code: ProviderErrorCode): ProviderError => ({ kind: 'ERROR', code });

/**
 * Where a payer may be sent: the sandbox's own https page host (`sandbox.sslcommerz.com`; P7a2-x21:
 * no other SSLCommerz host, now that guardians are sent there), or, with a fake SSLCommerz
 * (development and tests), that fake's own address. Never an address the gateway's answer chose
 * freely; anything else fails the payment before a guardian is sent anywhere.
 */
export function isAllowedCheckoutUrl(value: string, baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (baseUrl !== SSLCOMMERZ_SANDBOX_URL) return url.origin === new URL(baseUrl).origin;
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === 'https:' &&
    (url.port === '' || url.port === '443') &&
    host === 'sandbox.sslcommerz.com'
  );
}

/** What `APIConnect` says about the call itself (the query and validation APIs). */
function apiConnectError(value: string | null): ProviderError | null {
  if (value === null || value === 'DONE') return null;
  if (value === 'FAILED') return error('AUTH_FAILED');
  if (value === 'INACTIVE') return error('STORE_INACTIVE');
  if (value === 'INVALID_REQUEST') return error('INVALID_REQUEST');
  return error('BAD_RESPONSE');
}

/**
 * SSLCommerz behind `PaymentProvider` (docs/payments.md → The client): plain `fetch`, one attempt,
 * a 30 s timeout, redirects never followed, every answer parsed by a strict schema. The store
 * password travels in the session form and in the validation and query URLs (SSLCommerz's
 * design), so nothing here ever logs, rethrows or returns a URL, a body, a header or a `fetch`
 * error: each failure becomes a fixed code first.
 */
@Injectable()
export class SslcommerzProvider implements PaymentProvider {
  readonly key = 'SSLCOMMERZ' as const;
  readonly credentialsSchema = sslcommerzCredentialsSchema;

  constructor(@Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig) {}

  private get baseUrl(): string {
    return this.config.sslcommerzBaseUrl;
  }

  async testConnection(creds: SslcommerzCredentials): Promise<GatewayTestResult> {
    // A transaction that never existed: good credentials get "DONE" with nothing found.
    const answer = await this.query(creds, `JSTEST${newTranId().slice(8)}`);
    if (Array.isArray(answer)) return 'OK';
    switch (answer.code) {
      case 'AUTH_FAILED':
        return 'BAD_CREDENTIALS';
      case 'STORE_INACTIVE':
        return 'STORE_INACTIVE';
      case 'TIMEOUT':
      case 'NETWORK':
        return 'UNREACHABLE';
      default:
        return 'ERROR';
    }
  }

  async createCheckout(
    creds: SslcommerzCredentials,
    intent: CheckoutRequest,
  ): Promise<CheckoutResult> {
    const form = new URLSearchParams({
      store_id: creds.storeId,
      store_passwd: creds.storePassword,
      total_amount: formatGatewayAmount(intent.amountPaisa),
      currency: 'BDT',
      tran_id: intent.tranId,
      success_url: intent.urls.success,
      fail_url: intent.urls.fail,
      cancel_url: intent.urls.cancel,
      ipn_url: intent.urls.ipn,
      cus_name: intent.customer.name,
      cus_email: intent.customer.email,
      cus_add1: intent.customer.address,
      cus_city: intent.customer.city,
      cus_postcode: intent.customer.postcode,
      cus_country: intent.customer.country,
      cus_phone: intent.customer.phone,
      shipping_method: 'NO',
      // ASCII only: "বেতন ও ফি" is not sent.
      product_name: 'School fees',
      product_category: 'Education',
      product_profile: 'non-physical-goods',
      emi_option: '0',
      value_a: intent.intentId,
    });
    const answer = await this.call(SESSION_PATH, sessionAnswerSchema, {
      method: 'POST',
      body: form,
    });
    if ('kind' in answer) return answer;
    if (answer.status === 'FAILED') {
      // The reason is free text; only whether it is about the credentials is kept.
      return error(
        /credential/i.test(answer.failedreason ?? '') ? 'AUTH_FAILED' : 'INVALID_REQUEST',
      );
    }
    if (answer.status !== 'SUCCESS') return error('BAD_RESPONSE');
    const sessionRef = answer.sessionkey;
    const redirectUrl = answer.GatewayPageURL;
    if (!sessionRef || sessionRef.length > 100 || !/^[\x21-\x7e]+$/.test(sessionRef)) {
      return error('BAD_RESPONSE');
    }
    if (!redirectUrl || !isAllowedCheckoutUrl(redirectUrl, this.baseUrl)) {
      return error('BAD_RESPONSE');
    }
    return { kind: 'OK', redirectUrl, sessionRef };
  }

  async confirm(
    creds: SslcommerzCredentials,
    ref: { tranId: string; valId: string },
  ): Promise<ProviderOutcome> {
    const answer = await this.call(VALIDATION_PATH, validationAnswerSchema, {
      method: 'GET',
      query: {
        val_id: ref.valId,
        store_id: creds.storeId,
        store_passwd: creds.storePassword,
        format: 'json',
      },
    });
    if ('kind' in answer) return answer;
    const refused = apiConnectError(answer.APIConnect);
    if (refused) return refused;
    switch (answer.status) {
      case 'VALID':
      case 'VALIDATED': {
        const { valId, ...facts } = paymentFacts(answer);
        // The validation ID asked about must be the one answered for.
        if (valId !== ref.valId) return error('BAD_RESPONSE');
        return { kind: 'PAID', valId, repeated: answer.status === 'VALIDATED', ...facts };
      }
      case 'INVALID_TRANSACTION':
        return { kind: 'INVALID' };
      case 'PENDING':
        return { kind: 'PENDING' };
      case 'FAILED':
      case 'CANCELLED':
      case 'EXPIRED':
        return { kind: answer.status };
      default:
        return error('BAD_RESPONSE');
    }
  }

  async query(
    creds: SslcommerzCredentials,
    tranId: string,
  ): Promise<ProviderAttempt[] | ProviderError> {
    const answer = await this.call(QUERY_PATH, queryAnswerSchema, {
      method: 'GET',
      query: {
        tran_id: tranId,
        store_id: creds.storeId,
        store_passwd: creds.storePassword,
        format: 'json',
      },
    });
    if ('kind' in answer) return answer;
    if (answer.APIConnect === null) return error('BAD_RESPONSE');
    const refused = apiConnectError(answer.APIConnect);
    if (refused) return refused;
    return (answer.element ?? []).map((row) => ({
      status: attemptStatus(row.status),
      ...paymentFacts(row),
    }));
  }

  /**
   * One call: the parsed answer, or a fixed error. The URL (which may carry the password) and
   * anything `fetch` throws stay inside this method.
   */
  private async call<S extends z.ZodType>(
    path: string,
    schema: S,
    request:
      { method: 'POST'; body: URLSearchParams } | { method: 'GET'; query: Record<string, string> },
  ): Promise<z.output<S> | ProviderError> {
    const url = new URL(path, this.baseUrl);
    if (request.method === 'GET') {
      for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: request.method,
          headers: { Accept: 'application/json' },
          ...(request.method === 'POST' ? { body: request.body } : {}),
          // A redirect could carry the password to another host: never followed.
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch {
        return error(timedOut ? 'TIMEOUT' : 'NETWORK');
      }
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel().catch(() => undefined);
        return error('HTTP_STATUS');
      }
      let body: string;
      try {
        body = await readLimited(response, MAX_ANSWER_BYTES);
      } catch {
        return error(timedOut ? 'TIMEOUT' : 'BAD_RESPONSE');
      }
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        return error('BAD_RESPONSE');
      }
      const parsed = schema.safeParse(json);
      return parsed.success ? parsed.data : error('BAD_RESPONSE');
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The body as text, refusing more than `limit` bytes. */
async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error('too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

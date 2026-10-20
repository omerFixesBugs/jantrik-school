import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantTx } from '@jantrik/db';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';

/** The platform request's transaction (app.platform_session set by PlatformContextInterceptor). */
@Injectable()
export class PlatformDb {
  constructor(private readonly context: RequestContext) {}

  get tx(): TenantTx {
    this.context.requirePlatform();
    const tx = this.context.tx;
    if (!tx) throw new Error('No platform transaction');
    return tx;
  }
}

/** What the platform functions raise (`RAISE EXCEPTION 'PLATFORM_…'`), as API errors. */
const KNOWN: Record<string, [status: number, code: string, message: string, field?: string]> = {
  PLATFORM_BAD_STATUS: [409, 'BAD_STATUS', 'Not possible in the institute’s current status'],
  PLATFORM_REASON_REQUIRED: [422, 'REASON_REQUIRED', 'A reason is required', 'reason'],
  PLATFORM_CORE_REQUIRED: [422, 'CORE_REQUIRED', 'The core module is always on'],
  PLATFORM_ALREADY_REGISTERED: [409, 'ALREADY_REGISTERED', 'The institute already has a plan'],
  PLATFORM_BAD_AMOUNT: [422, 'BAD_AMOUNT', 'More than is left to pay', 'amountPaisa'],
  PLATFORM_BAD_DATE: [422, 'BAD_DATE', 'The date is in the future or too far back'],
  PLATFORM_BAD_MONTH: [422, 'BAD_MONTH', 'At most next month can be invoiced'],
  PLATFORM_BAD_RATE: [
    422,
    'BAD_RATE',
    'The rate must be from ৳0 to ৳100',
    'smsCostPerSegmentPaisa',
  ],
  PLATFORM_INVOICE_CLOSED: [409, 'INVOICE_CLOSED', 'The invoice is already paid or void'],
  PLATFORM_INVOICE_HAS_PAYMENTS: [409, 'HAS_PAYMENTS', 'An invoice with payments cannot be voided'],
  PLATFORM_AMOUNT_TOO_LARGE: [422, 'AMOUNT_TOO_LARGE', 'The invoice amount is too large'],
};

export function platformDbError(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (/PLATFORM_NOT_FOUND/.test(message)) throw new NotFoundException('Not found');
  const key = /PLATFORM_[A-Z_]+/.exec(message)?.[0];
  const known = key ? KNOWN[key] : undefined;
  if (known) {
    const [status, code, text, field] = known;
    throw apiError(status, code, text, field ? { field } : undefined);
  }
  throw error;
}

import { parseGatewayAmount, signalFields } from '@jantrik/shared';
import { z } from 'zod';
import type { AttemptStatus, PaymentFacts } from '../provider.js';

// SSLCommerz's answers (developer docs v4, checked 2026-11-18; docs/payments.md → The client),
// parsed strictly: only the fields the checks need are kept, each a string of at most 200
// characters or nothing. A number where a string belongs is nothing too, so an amount is never
// read through a float. Every other field (card numbers, value_a…d, the customer) is dropped here.

/**
 * A short string, or null for anything else (missing, a number, an object, too long). Optional on
 * the way in, so a missing field is null rather than a parse error.
 */
const text = z
  .unknown()
  .optional()
  .transform((v) => (typeof v === 'string' && v.length <= 200 ? v : null));

/** The session API's answer (POST /gwprocess/v4/api.php). */
export const sessionAnswerSchema = z.object({
  status: text,
  sessionkey: text,
  GatewayPageURL: text,
  failedreason: text,
});

/** One payment's fields, as the validation API and each query element report them. */
const paymentFields = {
  status: text,
  tran_id: text,
  val_id: text,
  amount: text,
  store_amount: text,
  currency: text,
  currency_type: text,
  currency_amount: text,
  bank_tran_id: text,
  card_type: text,
  card_brand: text,
  risk_level: text,
  risk_title: text,
  tran_date: text,
  APIConnect: text,
};

/** The validation API's answer (GET /validator/api/validationserverAPI.php). */
export const validationAnswerSchema = z.object(paymentFields);

/** The transaction query API's answer (GET /validator/api/merchantTransIDvalidationAPI.php). */
export const queryAnswerSchema = z.object({
  APIConnect: text,
  no_of_trans_found: z.unknown().optional(),
  element: z.array(z.object(paymentFields)).max(50).nullish(),
});

type PaymentFieldsRow = z.output<z.ZodObject<typeof paymentFields>>;

/** `tran_date` ("2026-11-18 10:30:15", Asia/Dhaka, UTC+6 all year) → a Date, or null. */
export function parseTranDate(value: string | null): Date | null {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value) : null;
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+06:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The money facts of one row. */
export function paymentFacts(row: PaymentFieldsRow): PaymentFacts {
  return {
    tranId: row.tran_id,
    valId: row.val_id,
    amountPaisa: parseGatewayAmount(row.amount),
    currency: row.currency,
    currencyType: row.currency_type,
    currencyAmountPaisa: parseGatewayAmount(row.currency_amount),
    storeAmountPaisa: parseGatewayAmount(row.store_amount),
    bankTranId: row.bank_tran_id,
    instrument: row.card_type === null ? null : row.card_type.slice(0, 50),
    cardBrand: row.card_brand,
    // Only the documented "0" is low risk; anything else, missing included, waits for a person.
    risk: row.risk_level === '0' ? 'LOW' : 'HIGH',
    paidAt: parseTranDate(row.tran_date),
    reported: signalFields(row),
  };
}

const KNOWN_STATUSES: readonly AttemptStatus[] = [
  'VALID',
  'VALIDATED',
  'PENDING',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'UNATTEMPTED',
];

export const attemptStatus = (status: string | null): AttemptStatus =>
  KNOWN_STATUSES.find((s) => s === status) ?? 'OTHER';

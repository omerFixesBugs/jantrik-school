/**
 * Online payment rules (sprint 1 P7a, docs/payments.md): pure functions shared by the API, the
 * web app and the tests. Money is integer paisa, never a float: a gateway's decimal string is
 * parsed digit by digit.
 */

/** SSLCommerz's documented range for one session: ৳10 to ৳5 lakh (P7a-L). */
export const ONLINE_MIN_PAISA = 1000;
export const ONLINE_MAX_PAISA = 50_000_000;

const GATEWAY_AMOUNT = /^(\d{1,7})(?:\.(\d{1,2}))?$/;

/**
 * A gateway's amount ("1250.50", "1250.5", "1250") → paisa, or null when it is not exactly that
 * shape: no sign, no grouping, no exponent, no spaces, ASCII digits, at most 2 decimals, below
 * ৳1 crore. Stricter than `parseTaka` (what people type).
 */
export function parseGatewayAmount(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const match = GATEWAY_AMOUNT.exec(value);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  return whole * 100 + fraction;
}

/** Paisa → the decimal a gateway is sent: 125050 → "1250.50", 1000 → "10.00". */
export function formatGatewayAmount(paisa: number): string {
  if (!Number.isSafeInteger(paisa) || paisa < 0) {
    throw new RangeError('A gateway amount is a whole, non-negative number of paisa');
  }
  return `${Math.floor(paisa / 100)}.${String(paisa % 100).padStart(2, '0')}`;
}

// ───────────────────────────── Our transaction IDs ─────────────────────────────

/** Crockford's base32 (no I, L, O, U), in ascending order, so IDs sort as their bits do. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Ours: "JS" + 26 Crockford base32 characters (48 bits of time, then 80 random bits). */
export const TRAN_ID_PATTERN = /^JS[0-9A-HJKMNP-TV-Z]{26}$/;

/** Web Crypto, in browsers and Node alike (this package's types name neither). */
const webCrypto = (
  globalThis as unknown as { crypto: { getRandomValues<T extends Uint8Array>(array: T): T } }
).crypto;

const defaultRandom = (bytes: number): Uint8Array =>
  webCrypto.getRandomValues(new Uint8Array(bytes));

/**
 * A new transaction ID for a gateway session (SSLCommerz `tran_id`, a string of at most 30):
 * "JS" and a ULID, so IDs sort by the time they were made and never repeat (80 random bits per
 * millisecond). `random(10)` returns 10 random bytes (Web Crypto by default).
 */
export function newTranId(
  now: Date | number = Date.now(),
  random: (bytes: number) => Uint8Array = defaultRandom,
): string {
  let time = typeof now === 'number' ? now : now.getTime();
  if (!Number.isSafeInteger(time) || time < 0 || time >= 2 ** 48) {
    throw new RangeError('A transaction ID needs a time between 1970 and 10889');
  }
  let head = '';
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD[time % 32]! + head;
    time = Math.floor(time / 32);
  }
  const bytes = random(10);
  if (bytes.length !== 10) throw new RangeError('A transaction ID needs 10 random bytes');
  // 80 bits → 16 characters of 5 bits, most significant first.
  let tail = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      tail += CROCKFORD[(buffer >> bits) & 31]!;
    }
    buffer &= (1 << bits) - 1;
  }
  return `JS${head}${tail}`;
}

// ───────────────────────────── What the gateway reports ─────────────────────────────

/** The methods an online payment can be recorded under (S21). */
export const GATEWAY_PAYMENT_METHODS = [
  'BKASH',
  'NAGAD',
  'ROCKET',
  'CARD',
  'OTHER_ONLINE',
] as const;
export type GatewayPaymentMethod = (typeof GATEWAY_PAYMENT_METHODS)[number];

/**
 * SSLCommerz `card_type` prefixes → method (P7a-J). The values come from SSLCommerz's older
 * connectivity guide and are checked in the sandbox (docs/payments.md); anything else is
 * OTHER_ONLINE, never a guess.
 */
const INSTRUMENT_PREFIXES: readonly (readonly [string, GatewayPaymentMethod])[] = [
  ['BKASH-', 'BKASH'],
  ['NAGAD-', 'NAGAD'],
  ['DBBLMOBILEB-', 'ROCKET'],
  ['VISA-', 'CARD'],
  ['MASTER-', 'CARD'],
  ['AMEX-', 'CARD'],
];
/** SSLCommerz `card_brand` values of a card. */
const CARD_BRANDS: readonly string[] = ['VISA', 'MASTERCARD', 'AMEX'];

/** The method of an online payment from SSLCommerz's `card_type` and `card_brand`. */
export function methodFromInstrument(
  cardType: string | null | undefined,
  cardBrand: string | null | undefined,
): GatewayPaymentMethod {
  const type = (cardType ?? '').trim().toUpperCase();
  for (const [prefix, method] of INSTRUMENT_PREFIXES) {
    if (type.startsWith(prefix)) return method;
  }
  if (CARD_BRANDS.includes((cardBrand ?? '').trim().toUpperCase())) return 'CARD';
  return 'OTHER_ONLINE';
}

const BANK_TRAN_ID = /^[A-Za-z0-9._-]{6,80}$/;

/**
 * A gateway's own transaction ID (SSLCommerz `bank_tran_id`) that can be stored as a payment's
 * TrxID (P7a-I): 6 to 80 letters, digits, dots, underscores or dashes. The documentation's sample
 * (`1709162025350IvUOK8nCTb6Uan`) has lower case letters and 27 characters.
 */
export function isWellFormedBankTranId(value: string | null | undefined): boolean {
  return typeof value === 'string' && BANK_TRAN_ID.test(value);
}

// ───────────────────────────── Signals (P7a2) ─────────────────────────────

/**
 * The only fields of a gateway signal (the payer's return, the IPN) or of a validation answer
 * that are ever stored (`payment_gateway_events.fields`; the table's CHECK says the same). Never
 * `card_no` (even masked), `verify_sign`, `verify_key`, `value_*`, `cus_*`, `store_id` or a
 * password. `val_id` and `tran_id` have columns of their own.
 */
export const SIGNAL_FIELDS = [
  'status',
  'tran_date',
  'amount',
  'store_amount',
  'currency',
  'currency_type',
  'currency_amount',
  'bank_tran_id',
  'card_type',
  'card_brand',
  'risk_level',
  'risk_title',
  'error',
] as const;
export type SignalField = (typeof SIGNAL_FIELDS)[number];

/** A stored value: printable ASCII, at most 100 characters (SSLCommerz's are short). */
const SIGNAL_VALUE = /^[\x20-\x7e]{0,100}$/;

/**
 * The whitelisted fields of a parsed form or answer, each kept only when it is a short printable
 * string. Anything else is dropped, never trusted: the gateway's validation API decides.
 */
export function signalFields(input: unknown): Partial<Record<SignalField, string>> {
  const out: Partial<Record<SignalField, string>> = {};
  if (typeof input !== 'object' || input === null) return out;
  for (const key of SIGNAL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string' && SIGNAL_VALUE.test(value)) out[key] = value;
  }
  return out;
}

const GATEWAY_REF = /^[A-Za-z0-9_.-]{1,50}$/;

/**
 * A gateway reference we store or send back to the gateway: a `val_id`, or a `tran_id` as a
 * signal carried it (ours or anyone's). 1 to 50 letters, digits, dots, underscores or dashes.
 */
export function isGatewayRef(value: unknown): value is string {
  return typeof value === 'string' && GATEWAY_REF.test(value);
}

/** How long a new intent blocks another checkout for the same child (P7a-F). */
export const ONLINE_INTENT_MINUTES = 60;

import { z } from 'zod';
import { toAsciiDigits } from './digits.js';

/** E.164 Bangladeshi mobile number, as stored in the DB (+8801XXXXXXXXX). */
export const BD_PHONE_E164 = /^\+8801[3-9]\d{8}$/;

/**
 * Normalise a Bangladeshi mobile number to E.164. Accepts the usual ways people type it,
 * including on a Bangla keyboard: `01712345678`, `০১৭১২৩৪৫৬৭৮`, `8801712345678`,
 * `+8801712345678`, `008801712345678`, with spaces, dashes, dots or brackets.
 * Returns null if it is not a valid BD mobile number.
 */
export function normalizeBdPhone(input: string): string | null {
  const digits = toAsciiDigits(input)
    .replace(/[\s\-().]/g, '')
    .replace(/^\+/, '')
    .replace(/^00/, '');
  if (!/^\d+$/.test(digits)) return null;
  const local = digits.startsWith('880')
    ? digits.slice(3)
    : digits.startsWith('0')
      ? digits.slice(1)
      : null;
  if (local === null) return null;
  const e164 = `+880${local}`;
  return BD_PHONE_E164.test(e164) ? e164 : null;
}

/** zod schema: parses any accepted format and outputs E.164. */
export const bdPhoneSchema = z.string().transform((value, ctx) => {
  const phone = normalizeBdPhone(value);
  if (!phone) {
    ctx.addIssue({ code: 'custom', message: 'Invalid Bangladeshi mobile number' });
    return z.NEVER;
  }
  return phone;
});

/**
 * Display form of an E.164 BD number: `01712-345678`. Always ASCII digits (see format.ts), so it
 * can be pasted into a dialer or WhatsApp.
 */
export function formatBdPhone(e164: string): string {
  const local = `0${e164.replace(/^\+880/, '')}`;
  return local.length === 11 ? `${local.slice(0, 5)}-${local.slice(5)}` : e164;
}

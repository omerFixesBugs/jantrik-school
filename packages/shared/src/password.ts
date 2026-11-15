import { z } from 'zod';
import { toAsciiDigits } from './digits.js';

/**
 * Staff passwords (S26). Lengths count Unicode code points after NFC, so a Bangla password counts
 * what the person typed, whichever keyboard composed it. No composition rules (digits, symbols).
 */
export const PASSWORD_RULES = { min: 10, max: 128 } as const;

/** Institute names shorter than this (without spaces) are not checked: they would refuse most passwords. */
const MIN_NAME_LETTERS = 4;

/** `TOO_COMMON` is added by the server, which holds the common-password list. */
export type PasswordProblem = 'TOO_SHORT' | 'TOO_LONG' | 'HAS_PHONE' | 'HAS_INSTITUTE_NAME';

/**
 * The one form a password is hashed and verified in (P1-C): NFC, so composed and decomposed input
 * (e.g. য় as one code point or two) give the same password.
 */
export function normalizePassword(pw: string): string {
  return pw.normalize('NFC');
}

/** NFC, lower-case, without whitespace: how passwords and institute names are compared. */
function comparable(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/gu, '');
}

/** The 10-digit national number (`17XXXXXXXX`) of a Bangladeshi phone, or null if there is none. */
function nationalNumber(phone: string): string | null {
  const digits = toAsciiDigits(phone).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * What is wrong with a password, given who sets it (S26, P1-D). Empty when it may be used. The
 * server passes the names of every institute the person belongs to; the web, the current one.
 */
export function passwordProblems(
  pw: string,
  about: { phone: string; instituteNames: readonly string[] },
): PasswordProblem[] {
  const password = normalizePassword(pw);
  const problems: PasswordProblem[] = [];
  const length = [...password].length;
  if (length < PASSWORD_RULES.min) problems.push('TOO_SHORT');
  if (length > PASSWORD_RULES.max) problems.push('TOO_LONG');

  // The phone in any form: 01…, +8801…, 8801…, Bangla digits, with spaces, dashes or dots.
  const national = nationalNumber(about.phone);
  const passwordDigits = toAsciiDigits(password).replace(/[\s.+-]/g, '');
  if (national && passwordDigits.includes(national)) problems.push('HAS_PHONE');

  const passwordText = comparable(password);
  const hasName = about.instituteNames.some((name) => {
    const n = comparable(name);
    return [...n].length >= MIN_NAME_LETTERS && passwordText.includes(n);
  });
  if (hasName) problems.push('HAS_INSTITUTE_NAME');
  return problems;
}

/**
 * `PUT /me/password`. The code accepts Bangla digits and surrounding spaces. The password is only
 * capped here (a hashing cost bound); its rules are `passwordProblems` plus the server's list.
 */
export const setPasswordSchema = z.object({
  code: z
    .string()
    .trim()
    .transform(toAsciiDigits)
    .pipe(z.string().regex(/^\d{6}$/, 'Code must be 6 digits')),
  password: z.string().max(512),
});
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;

/** `GET /me/password`. */
export interface PasswordStatus {
  hasPassword: boolean;
  /** ISO time the person last set it themselves; null if never. */
  changedAt: string | null;
}

/** `POST /me/password/code` (202). */
export interface PasswordCodeSent {
  /** Seconds the code stays valid. */
  expiresIn: number;
  /** The phone the code went to, mostly hidden, e.g. `017•••••002`. */
  phoneHint: string;
}

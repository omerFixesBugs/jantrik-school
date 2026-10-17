const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const BN_DIGIT_RE = /[০-৯]/g;

/**
 * Replace Bangla digits (০-৯) with ASCII digits. Apply to any user input that may come from a
 * Bangla keyboard: phone numbers, codes, search queries, amounts.
 */
export function toAsciiDigits(input: string): string {
  return input.replace(BN_DIGIT_RE, (d) => String(BN_DIGITS.indexOf(d)));
}

/** Replace ASCII digits with Bangla digits. Prefer the formatters in `format.ts`. */
export function toBanglaDigits(input: string): string {
  return input.replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]!);
}

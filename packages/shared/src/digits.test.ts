import { describe, expect, it } from 'vitest';
import { toAsciiDigits, toBanglaDigits } from './digits.js';
import { formatCount, formatDate, formatIdentifier, formatTaka } from './format.js';
import { formatBdPhone, normalizeBdPhone } from './phone.js';

describe('Bangla digits', () => {
  it('converts both ways', () => {
    expect(toAsciiDigits('০১২৩৪৫৬৭৮৯')).toBe('0123456789');
    expect(toBanglaDigits('0123456789')).toBe('০১২৩৪৫৬৭৮৯');
    expect(toAsciiDigits('রোল ১২, ক্লাস 9')).toBe('রোল 12, ক্লাস 9');
  });
});

describe('normalizeBdPhone with Bangla keyboards and common formats', () => {
  it.each([
    '০১৭১২৩৪৫৬৭৮',
    '+৮৮০১৭১২৩৪৫৬৭৮',
    '৮৮০ ১৭১২-৩৪৫৬৭৮',
    '০১৭১২-৩৪৫৬৭৮',
    '+880 1712 345678',
    '880-1712-345678',
    '(01712) 345 678',
    '01712.345.678',
  ])('%s → +8801712345678', (input) => {
    expect(normalizeBdPhone(input)).toBe('+8801712345678');
  });

  it.each(['০১২১২৩৪৫৬৭৮', '+880 1712 34567', 'O1712345678', '01712345678x'])(
    'rejects %s',
    (input) => {
      expect(normalizeBdPhone(input)).toBeNull();
    },
  );

  it('formats for display with ASCII digits', () => {
    expect(formatBdPhone('+8801712345678')).toBe('01712-345678');
  });
});

describe('display rule: Bangla digits for quantities, ASCII for identifiers', () => {
  it('quantities use Bangla digits in bn and ASCII in en', () => {
    expect(formatCount(1234, 'bn')).toBe('১,২৩৪');
    expect(formatCount(1234, 'en')).toBe('1,234');
    expect(formatTaka(125050, 'bn')).toBe('৳১,২৫০.৫০');
    expect(formatTaka(120000, 'en')).toBe('৳1,200');
    expect(formatDate('2026-10-17T06:00:00Z', 'bn')).toMatch(/১৭/);
    expect(formatDate('2026-10-17T06:00:00Z', 'en')).toMatch(/17/);
  });

  it('dates are shown in Asia/Dhaka', () => {
    // 20:00 UTC on 17 Oct is already 18 Oct in Dhaka (UTC+6).
    expect(formatDate('2026-10-17T20:00:00Z', 'en')).toMatch(/^18 /);
  });

  it('identifiers are always ASCII', () => {
    expect(formatIdentifier('SHS-২০২৬-০০১')).toBe('SHS-2026-001');
    expect(formatIdentifier(12)).toBe('12');
  });
});

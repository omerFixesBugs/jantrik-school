import { describe, expect, it } from 'vitest';
import { formatDateInput, parseDateInput } from './date-input.js';

describe('parseDateInput', () => {
  it('reads day-first dates in ASCII or Bangla digits', () => {
    expect(parseDateInput('21/10/2026')).toBe('2026-10-21');
    expect(parseDateInput('২১/১০/২০২৬')).toBe('2026-10-21');
    expect(parseDateInput('1/2/2014')).toBe('2014-02-01');
    expect(parseDateInput(' 05-06-2015 ')).toBe('2015-06-05');
    expect(parseDateInput('05.06.2015')).toBe('2015-06-05');
  });
  it('reads ISO dates', () => {
    expect(parseDateInput('2026-10-01')).toBe('2026-10-01');
    expect(parseDateInput('২০২৬-১০-০১')).toBe('2026-10-01');
  });
  it('rejects impossible or partial dates', () => {
    expect(parseDateInput('31/02/2026')).toBeNull();
    expect(parseDateInput('29/02/2025')).toBeNull();
    expect(parseDateInput('29/02/2024')).toBe('2024-02-29');
    expect(parseDateInput('12/13/2026')).toBeNull();
    expect(parseDateInput('21/10/26')).toBeNull();
    expect(parseDateInput('21/10')).toBeNull();
    expect(parseDateInput('')).toBeNull();
    expect(parseDateInput('tomorrow')).toBeNull();
  });
});

describe('formatDateInput', () => {
  it('writes day first, Bangla digits in Bangla', () => {
    expect(formatDateInput('2026-10-01', 'en')).toBe('01/10/2026');
    expect(formatDateInput('2026-10-01', 'bn')).toBe('০১/১০/২০২৬');
  });
  it('leaves anything that is not ISO as it is', () => {
    expect(formatDateInput('soon', 'en')).toBe('soon');
  });
  it('round-trips through the parser', () => {
    for (const d of ['2014-02-01', '2026-12-31'])
      for (const l of ['bn', 'en'] as const) expect(parseDateInput(formatDateInput(d, l))).toBe(d);
  });
});

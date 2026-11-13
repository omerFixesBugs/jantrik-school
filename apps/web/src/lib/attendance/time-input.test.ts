import { describe, expect, it } from 'vitest';
import { inputDigits, isTime, normalizeTime, wholeNumber } from './time-input';

describe('normalizeTime', () => {
  it('takes Bangla or ASCII digits and pads the hour', () => {
    expect(normalizeTime('০৮:০৫')).toBe('08:05');
    expect(normalizeTime('৮:০৫')).toBe('08:05');
    expect(normalizeTime(' 9.30 ')).toBe('09:30');
    expect(normalizeTime('16:00')).toBe('16:00');
  });

  it('leaves text that is not a time for the API to refuse', () => {
    expect(normalizeTime('৮টা')).toBe('8টা');
    expect(normalizeTime('')).toBe('');
  });
});

describe('isTime', () => {
  it('is a time of day after normalizing', () => {
    expect(isTime('০৯:৩০')).toBe(true);
    expect(isTime('7:45')).toBe(true);
    expect(isTime('23:59')).toBe(true);
    expect(isTime('24:00')).toBe(false);
    expect(isTime('09:60')).toBe(false);
    expect(isTime('9')).toBe(false);
  });
});

describe('wholeNumber', () => {
  it('reads either digits', () => {
    expect(wholeNumber('৯০০১')).toBe(9001);
    expect(wholeNumber(' 60 ')).toBe(60);
    expect(wholeNumber('')).toBeNull();
    expect(wholeNumber('1.5')).toBeNull();
    expect(wholeNumber('-3')).toBeNull();
  });
});

describe('inputDigits', () => {
  it('shows Bangla digits in the Bangla UI only', () => {
    expect(inputDigits('08:00', 'bn')).toBe('০৮:০০');
    expect(inputDigits(10, 'bn')).toBe('১০');
    expect(inputDigits('08:00', 'en')).toBe('08:00');
  });
});

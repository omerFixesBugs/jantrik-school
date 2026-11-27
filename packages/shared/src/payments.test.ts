import { describe, expect, it } from 'vitest';
import {
  formatGatewayAmount,
  isWellFormedBankTranId,
  methodFromInstrument,
  newTranId,
  ONLINE_MAX_PAISA,
  ONLINE_MIN_PAISA,
  parseGatewayAmount,
  TRAN_ID_PATTERN,
} from './payments.js';

describe('parseGatewayAmount (what SSLCommerz answers → paisa, exactly)', () => {
  it.each([
    ['1250.50', 125050],
    ['1250.5', 125050],
    ['1250', 125000],
    ['0.01', 1],
    ['10.00', 1000],
    ['500000.00', 50000000],
    ['9999999.99', 999999999],
  ])('%s → %i', (input, paisa) => {
    expect(parseGatewayAmount(input)).toBe(paisa);
  });

  it.each([
    '1,250.50',
    '১২৫০.৫০',
    '-1.00',
    '1250.505',
    '1e3',
    '+10',
    ' 10.00',
    '10.00 ',
    '',
    'NaN',
    'Infinity',
    '10000000.00',
    '.50',
    '10.',
    '0x10',
  ])('refuses %j', (input) => {
    expect(parseGatewayAmount(input)).toBeNull();
  });

  it('refuses what is not a string', () => {
    for (const value of [null, undefined, 1250, 12.5, {}, []]) {
      expect(parseGatewayAmount(value as unknown as string)).toBeNull();
    }
  });
});

describe('formatGatewayAmount (paisa → the decimal SSLCommerz is sent)', () => {
  it('two decimals, no grouping, ASCII digits', () => {
    expect(formatGatewayAmount(125050)).toBe('1250.50');
    expect(formatGatewayAmount(1000)).toBe('10.00');
    expect(formatGatewayAmount(5)).toBe('0.05');
    expect(formatGatewayAmount(50_000_000)).toBe('500000.00');
  });

  it('refuses what is not a whole, non-negative paisa amount', () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => formatGatewayAmount(value)).toThrow();
    }
  });

  it('round-trips with parseGatewayAmount', () => {
    for (const paisa of [ONLINE_MIN_PAISA, 123_456, ONLINE_MAX_PAISA]) {
      expect(parseGatewayAmount(formatGatewayAmount(paisa))).toBe(paisa);
    }
  });

  it('the online range is SSLCommerz documented one: ৳10 to ৳5 lakh', () => {
    expect(ONLINE_MIN_PAISA).toBe(1000);
    expect(ONLINE_MAX_PAISA).toBe(50_000_000);
  });
});

describe('newTranId (our transaction ID)', () => {
  it('is JS + 26 Crockford base32 characters', () => {
    const id = newTranId();
    expect(id).toHaveLength(28);
    expect(id).toMatch(TRAN_ID_PATTERN);
    expect(TRAN_ID_PATTERN.source).toBe('^JS[0-9A-HJKMNP-TV-Z]{26}$');
  });

  it('sorts by time', () => {
    const fixed = () => new Uint8Array(10).fill(255);
    const zero = () => new Uint8Array(10);
    const a = newTranId(new Date('2026-11-27T10:00:00.000Z'), fixed);
    const b = newTranId(new Date('2026-11-27T10:00:00.001Z'), zero);
    const c = newTranId(new Date('2027-01-01T00:00:00.000Z'), zero);
    expect([c, b, a].sort()).toEqual([a, b, c]);
    // The same millisecond: the random part decides, and the time part is equal.
    expect(newTranId(new Date(0), zero)).toBe(`JS${'0'.repeat(26)}`);
    expect(newTranId(new Date(0), fixed)).toBe(`JS${'0'.repeat(10)}${'Z'.repeat(16)}`);
  });

  it('10 000 of them are distinct', () => {
    const now = new Date('2026-11-27T10:00:00.000Z');
    const ids = new Set(Array.from({ length: 10_000 }, () => newTranId(now)));
    expect(ids.size).toBe(10_000);
  });

  it('fits SSLCommerz tran_id (a string of at most 30)', () => {
    expect(newTranId().length).toBeLessThanOrEqual(30);
  });
});

describe('methodFromInstrument (SSLCommerz card_type and card_brand → our method, S21)', () => {
  it.each([
    ['BKASH-BKash', null, 'BKASH'],
    ['NAGAD-Nagad', null, 'NAGAD'],
    ['DBBLMOBILEB-Dbbl Mobile Banking', null, 'ROCKET'],
    ['VISA-Brac bank', null, 'CARD'],
    ['MASTER-City Bank', null, 'CARD'],
    ['AMEX-City Bank', null, 'CARD'],
    ['VISA-Dutch Bangla', 'VISA', 'CARD'],
    ['DBBLNEXUS-DBBL Nexus', 'MASTERCARD', 'CARD'],
    ['', 'AMEX', 'CARD'],
    ['IBBL-Islami Bank', null, 'OTHER_ONLINE'],
    ['', null, 'OTHER_ONLINE'],
    [null, null, 'OTHER_ONLINE'],
    ['bkash-BKash', null, 'BKASH'],
    ['BKASHX', null, 'OTHER_ONLINE'],
    ['UPAY-Upay', 'MOBILEBANKING', 'OTHER_ONLINE'],
  ])('%j / %j → %s', (cardType, cardBrand, method) => {
    expect(methodFromInstrument(cardType, cardBrand)).toBe(method);
  });
});

describe('isWellFormedBankTranId', () => {
  it("accepts the documentation's sample and refuses what does not fit a TrxID", () => {
    expect(isWellFormedBankTranId('1709162025350IvUOK8nCTb6Uan')).toBe(true);
    expect(isWellFormedBankTranId('ABC123')).toBe(true);
    expect(isWellFormedBankTranId('a.b_c-1')).toBe(true);
    expect(isWellFormedBankTranId('x'.repeat(80))).toBe(true);
    for (const value of ['', 'ABC12', 'x'.repeat(81), 'ABC 123', 'ABC/123', 'ব্যাংক১২৩৪৫৬', null]) {
      expect(isWellFormedBankTranId(value as string)).toBe(false);
    }
  });
});

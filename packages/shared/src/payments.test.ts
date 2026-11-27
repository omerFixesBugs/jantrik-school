import { describe, expect, it } from 'vitest';
import {
  FEE_PAYMENT_CHANNELS,
  FEE_PAYMENT_METHOD_LABELS,
  FEE_PAYMENT_METHODS,
} from './fees.js';
import {
  ONLINE_PAYMENT_STATES,
  PAYMENT_INTENT_STATUSES,
  onlinePaymentState,
  startOnlinePaymentSchema,
} from './payments-api.js';
import {
  formatGatewayAmount,
  GATEWAY_PAYMENT_METHODS,
  isGatewayRef,
  isWellFormedBankTranId,
  methodFromInstrument,
  newTranId,
  ONLINE_MAX_PAISA,
  ONLINE_MIN_PAISA,
  parseGatewayAmount,
  SIGNAL_FIELDS,
  signalFields,
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

// ───────────────────────────── P7a2: checkout to receipt ─────────────────────────────

describe('the methods and channels a fee payment can have (S21)', () => {
  it('lists the gateway methods after the counter and manual ones, each with a label', () => {
    expect(FEE_PAYMENT_METHODS).toEqual([
      'CASH',
      'BKASH',
      'NAGAD',
      'ROCKET',
      'CARD',
      'OTHER_ONLINE',
    ]);
    expect(FEE_PAYMENT_CHANNELS).toEqual(['COUNTER', 'MOBILE_MANUAL', 'GATEWAY']);
    for (const method of FEE_PAYMENT_METHODS) {
      expect(FEE_PAYMENT_METHOD_LABELS[method].bn.length, method).toBeGreaterThan(0);
      expect(FEE_PAYMENT_METHOD_LABELS[method].en.length, method).toBeGreaterThan(0);
    }
    expect(FEE_PAYMENT_METHOD_LABELS.ROCKET).toEqual({ bn: 'রকেট', en: 'Rocket' });
    // Every method the gateway can be recorded under is a fee payment method.
    for (const method of GATEWAY_PAYMENT_METHODS) expect(FEE_PAYMENT_METHODS).toContain(method);
  });
});

describe('signalFields (what a gateway signal may store, nothing else)', () => {
  it('keeps the whitelisted keys with short printable values only', () => {
    expect(
      signalFields({
        status: 'VALID',
        tran_date: '2026-11-18 10:30:15',
        amount: '1250.50',
        store_amount: '1219.24',
        currency: 'BDT',
        currency_type: 'BDT',
        currency_amount: '1250.50',
        bank_tran_id: '1709162025350IvUOK8nCTb6Uan',
        card_type: 'BKASH-BKash',
        card_brand: 'MOBILEBANKING',
        risk_level: '0',
        risk_title: 'Safe',
        error: '',
        // Never stored: the card number (even masked), the signature, the customer, our values.
        card_no: '01711XXXXXX',
        verify_sign: 'abc',
        verify_key: 'amount,status',
        value_a: 'intent',
        cus_name: 'Karim',
        store_id: 'jantrik0001',
        store_passwd: 'secret',
        val_id: 'VAL123',
        tran_id: 'JS01',
      }),
    ).toEqual({
      status: 'VALID',
      tran_date: '2026-11-18 10:30:15',
      amount: '1250.50',
      store_amount: '1219.24',
      currency: 'BDT',
      currency_type: 'BDT',
      currency_amount: '1250.50',
      bank_tran_id: '1709162025350IvUOK8nCTb6Uan',
      card_type: 'BKASH-BKash',
      card_brand: 'MOBILEBANKING',
      risk_level: '0',
      risk_title: 'Safe',
      error: '',
    });
  });

  it('drops a value that is not a short printable string', () => {
    expect(
      signalFields({
        status: ['VALID', 'FAILED'],
        amount: 1250.5,
        currency: { a: 'BDT' },
        card_type: 'x'.repeat(101),
        risk_title: 'নিরাপদ',
        error: 'line\nbreak',
        risk_level: '0',
      }),
    ).toEqual({ risk_level: '0' });
    expect(signalFields(null)).toEqual({});
    expect(signalFields('status=VALID')).toEqual({});
    // Keys of the object's prototype are never read.
    expect(signalFields(Object.create({ status: 'VALID' }))).toEqual({});
  });

  it('bounds what one signal can store (the table refuses more than 4000 bytes)', () => {
    const all = Object.fromEntries(SIGNAL_FIELDS.map((k) => [k, 'x'.repeat(100)]));
    expect(JSON.stringify(signalFields(all)).length).toBeLessThan(4000);
  });
});

describe('gateway references (val_id, a tran_id in a signal)', () => {
  it('are 1 to 50 letters, digits, dots, underscores or dashes', () => {
    for (const ok of ['VAL123', '2311181030411Xh9oR8Og8Mm8dQ', 'a.b_c-1', 'x'.repeat(50)]) {
      expect(isGatewayRef(ok), ok).toBe(true);
    }
    for (const bad of ['', 'x'.repeat(51), 'VAL 1', 'VAL/1', "VAL'1", 'ভাল১', null, 12]) {
      expect(isGatewayRef(bad as string), String(bad)).toBe(false);
    }
  });
});

describe('onlinePaymentState (what a guardian may know of an intent)', () => {
  it.each([
    ['CREATED', false, 'PREPARING'],
    ['REDIRECTED', false, 'READY'],
    ['REDIRECTED', true, 'CONFIRMING'],
    ['PAID', true, 'PAID'],
    ['NEEDS_REVIEW', true, 'CHECKING'],
    ['NEEDS_REVIEW', false, 'CHECKING'],
    ['FAILED', true, 'NOT_PAID'],
    ['CANCELLED', false, 'NOT_PAID'],
    ['DISMISSED', true, 'NOT_PAID'],
    ['EXPIRED', false, 'EXPIRED'],
    ['REFUNDED_OUTSIDE', true, 'REFUNDED'],
  ] as const)('%s (signal seen: %s) → %s', (status, signalled, state) => {
    expect(onlinePaymentState(status, signalled)).toBe(state);
  });

  it('covers every status, and review reasons are never part of it', () => {
    for (const status of PAYMENT_INTENT_STATUSES) {
      expect(ONLINE_PAYMENT_STATES).toContain(onlinePaymentState(status, false));
    }
  });
});

describe('the online payment request (S22: dues, never an amount)', () => {
  const ok = {
    dueIds: ['01936b2e-6f2a-7c6e-9d3f-1a2b3c4d5e6f'],
    expectedAmountPaisa: 120000,
    clientRequestId: '01936b2e-6f2a-7c6e-9d3f-1a2b3c4d5e70',
  };

  it('takes due ids, the amount the guardian saw and a request id', () => {
    expect(startOnlinePaymentSchema.parse(ok)).toEqual(ok);
  });

  it('refuses an amount, no dues, too many, repeated ones or a bad id', () => {
    for (const body of [
      { ...ok, amountPaisa: 100 },
      { ...ok, dueIds: [] },
      {
        ...ok,
        dueIds: Array.from(
          { length: 25 },
          (_, i) => `01936b2e-6f2a-7c6e-9d3f-1a2b3c4d5e${String(i).padStart(2, '0')}`,
        ),
      },
      { ...ok, dueIds: [ok.dueIds[0], ok.dueIds[0]] },
      { ...ok, dueIds: ['not-a-uuid'] },
      { ...ok, expectedAmountPaisa: -1 },
      { ...ok, expectedAmountPaisa: 1.5 },
      { ...ok, clientRequestId: 'x' },
    ]) {
      expect(startOnlinePaymentSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

import { describe, expect, it } from 'vitest';
import type { PaymentIntentStatus } from '@jantrik/shared';
import { decideSettlement, mismatchReasons, type PaidFacts } from './settle-decision.js';

// The one decision table that posts gateway money (sprint 1 P7a2, docs/payments.md → settle; S23:
// anything SSLCommerz flags as risky, or any mismatch in amount, currency or transaction ID, goes
// to review and is never posted automatically).

const TRAN = 'JS01KBXR7S2Z0000000000000000';
const OTHER_TRAN = 'JS01KBXR7S2Z1111111111111111';

const paid = (over: Partial<PaidFacts> = {}): PaidFacts => ({
  valId: 'VAL1',
  tranId: TRAN,
  amountPaisa: 120000,
  currency: 'BDT',
  currencyType: 'BDT',
  currencyAmountPaisa: 120000,
  bankTranId: '1709162025350IvUOK8nCTb6Uan',
  risk: 'LOW',
  ...over,
});

const intent = (status: PaymentIntentStatus, valId: string | null = null) => ({
  status,
  tranId: TRAN,
  amountPaisa: 120000,
  valId,
});

describe('mismatchReasons (CREATED/REDIRECTED: what keeps a payment from posting)', () => {
  it('none for the exact money: our tran_id, BDT, the amount, low risk, the dues unchanged', () => {
    expect(mismatchReasons(intent('REDIRECTED'), paid(), false)).toEqual([]);
  });

  it.each([
    ['amount 1199.99', { amountPaisa: 119999 }, 'AMOUNT_MISMATCH'],
    ['amount more', { amountPaisa: 120001 }, 'AMOUNT_MISMATCH'],
    ['amount unparseable', { amountPaisa: null }, 'AMOUNT_MISMATCH'],
    ['currency_amount 1201.00', { currencyAmountPaisa: 120100 }, 'AMOUNT_MISMATCH'],
    ['currency_amount missing', { currencyAmountPaisa: null }, 'AMOUNT_MISMATCH'],
    ['currency USD', { currency: 'USD' }, 'CURRENCY_MISMATCH'],
    ['currency_type USD', { currencyType: 'USD' }, 'CURRENCY_MISMATCH'],
    ['currency missing', { currency: null }, 'CURRENCY_MISMATCH'],
    ['currency lower case', { currencyType: 'bdt' }, 'CURRENCY_MISMATCH'],
    ['no bank_tran_id', { bankTranId: null }, 'TRAN_ID_MISMATCH'],
    ['a malformed bank_tran_id', { bankTranId: 'AB 12/34' }, 'TRAN_ID_MISMATCH'],
    ['risk_level not "0" (or missing)', { risk: 'HIGH' as const }, 'HIGH_RISK'],
  ])('%s → %s', (_label, over, reason) => {
    expect(mismatchReasons(intent('REDIRECTED'), paid(over), false)).toEqual([reason]);
  });

  it('a due changed meanwhile → DUES_CHANGED; several reasons all listed, in a fixed order', () => {
    expect(mismatchReasons(intent('CREATED'), paid(), true)).toEqual(['DUES_CHANGED']);
    expect(
      mismatchReasons(
        intent('CREATED'),
        paid({ risk: 'HIGH', amountPaisa: 1, currency: 'USD' }),
        true,
      ),
    ).toEqual(['AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'HIGH_RISK', 'DUES_CHANGED']);
  });
});

describe('decideSettlement', () => {
  it('posts an open intent only when nothing is wrong', () => {
    for (const status of ['CREATED', 'REDIRECTED'] as const) {
      expect(decideSettlement(intent(status), paid(), { duesChanged: false })).toEqual({
        kind: 'POST',
      });
      expect(
        decideSettlement(intent(status), paid({ risk: 'HIGH' }), { duesChanged: false }),
      ).toEqual({
        kind: 'REVIEW',
        recordFacts: true,
        addReasons: ['HIGH_RISK'],
        eventReason: null,
      });
      expect(decideSettlement(intent(status), paid(), { duesChanged: true })).toEqual({
        kind: 'REVIEW',
        recordFacts: true,
        addReasons: ['DUES_CHANGED'],
        eventReason: null,
      });
    }
  });

  it('a repeat of the val_id the intent holds changes nothing, whatever its state', () => {
    for (const status of ['PAID', 'NEEDS_REVIEW', 'REFUNDED_OUTSIDE', 'DISMISSED'] as const) {
      expect(decideSettlement(intent(status, 'VAL1'), paid(), { duesChanged: false })).toEqual({
        kind: 'NOTHING',
      });
    }
  });

  it('another val_id for an intent that holds money: a DUPLICATE event, the intent unchanged', () => {
    for (const status of ['PAID', 'NEEDS_REVIEW', 'REFUNDED_OUTSIDE', 'DISMISSED'] as const) {
      expect(
        decideSettlement(intent(status, 'VAL0'), paid({ valId: 'VAL2' }), { duesChanged: false }),
      ).toEqual({ kind: 'EVENT_ONLY', eventReason: 'DUPLICATE' });
    }
  });

  it('NEEDS_REVIEW with no money yet: the facts recorded, still in review (never posted)', () => {
    expect(decideSettlement(intent('NEEDS_REVIEW'), paid(), { duesChanged: false })).toEqual({
      kind: 'REVIEW',
      recordFacts: true,
      addReasons: [],
      eventReason: null,
    });
  });

  it('a success after the intent closed (failed, cancelled, expired, dismissed): LATE_SUCCESS', () => {
    for (const status of ['FAILED', 'CANCELLED', 'EXPIRED', 'DISMISSED'] as const) {
      expect(decideSettlement(intent(status), paid(), { duesChanged: false })).toEqual({
        kind: 'REVIEW',
        recordFacts: true,
        addReasons: ['LATE_SUCCESS'],
        eventReason: null,
      });
    }
    expect(
      decideSettlement(intent('CANCELLED'), paid({ amountPaisa: 5 }), { duesChanged: false }),
    ).toMatchObject({ addReasons: ['LATE_SUCCESS', 'AMOUNT_MISMATCH'] });
  });

  it('money for another tran_id: no money recorded here; open or closed intents go to review (P7a-H)', () => {
    const other = paid({ tranId: OTHER_TRAN });
    for (const status of [
      'CREATED',
      'REDIRECTED',
      'FAILED',
      'CANCELLED',
      'EXPIRED',
      'DISMISSED',
      'NEEDS_REVIEW',
    ] as const) {
      expect(
        decideSettlement(intent(status), other, { duesChanged: false, otherIntent: true }),
        status,
      ).toEqual({
        kind: 'REVIEW',
        recordFacts: false,
        addReasons: ['TRAN_ID_MISMATCH'],
        eventReason: null,
      });
    }
    // A PAID or refunded intent keeps its state: the event is the record.
    for (const status of ['PAID', 'REFUNDED_OUTSIDE'] as const) {
      expect(
        decideSettlement(intent(status, 'VAL0'), other, { duesChanged: false, otherIntent: true }),
      ).toEqual({ kind: 'EVENT_ONLY', eventReason: null });
    }
    // Not ours at all (no intent of this institute has that tran_id): the event is UNMATCHED.
    expect(decideSettlement(intent('REDIRECTED'), other, { duesChanged: false })).toMatchObject({
      kind: 'REVIEW',
      eventReason: 'UNMATCHED',
    });
    expect(
      decideSettlement(intent('REDIRECTED'), paid({ tranId: null }), { duesChanged: false }),
    ).toMatchObject({
      kind: 'REVIEW',
      addReasons: ['TRAN_ID_MISMATCH'],
      recordFacts: false,
    });
  });

  it('money for another tran_id whose val_id only signals anyone can send brought (P7a2-x30): the event only, the intent left as it is', () => {
    const other = paid({ tranId: OTHER_TRAN });
    for (const status of ['CREATED', 'REDIRECTED', 'NEEDS_REVIEW', 'CANCELLED'] as const) {
      // No intent of the institute has that tran_id: UNMATCHED, for P7b's queue.
      expect(
        decideSettlement(intent(status), other, { duesChanged: false, forgeable: true }),
        status,
      ).toEqual({ kind: 'EVENT_ONLY', eventReason: 'UNMATCHED' });
      // Another intent's money: posted through that intent's own signals.
      expect(
        decideSettlement(intent(status), other, {
          duesChanged: false,
          otherIntent: true,
          forgeable: true,
        }),
        status,
      ).toEqual({ kind: 'EVENT_ONLY', eventReason: null });
    }
    // Brought by SSLCommerz's listed address or listed by our query: P7a-H as before.
    expect(
      decideSettlement(intent('REDIRECTED'), other, { duesChanged: false, forgeable: false }),
    ).toEqual({
      kind: 'REVIEW',
      recordFacts: false,
      addReasons: ['TRAN_ID_MISMATCH'],
      eventReason: 'UNMATCHED',
    });
    // Our own tran_id: the validation answer decides, whoever brought the val_id.
    expect(
      decideSettlement(intent('REDIRECTED'), paid(), { duesChanged: false, forgeable: true }),
    ).toEqual({ kind: 'POST' });
  });

  it('after a unique violation (the bank_tran_id already on a live payment): review as DUPLICATE', () => {
    expect(
      decideSettlement(intent('REDIRECTED'), paid(), { duesChanged: false, duplicate: true }),
    ).toEqual({ kind: 'REVIEW', recordFacts: true, addReasons: ['DUPLICATE'], eventReason: null });
    // Reasons found as well are kept.
    expect(
      decideSettlement(intent('REDIRECTED'), paid({ risk: 'HIGH' }), {
        duesChanged: false,
        duplicate: true,
      }),
    ).toMatchObject({ addReasons: ['HIGH_RISK'] });
  });
});

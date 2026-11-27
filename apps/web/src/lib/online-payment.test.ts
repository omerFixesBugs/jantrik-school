import { describe, expect, it } from 'vitest';
import { abandonOffered } from './online-payment';

describe('abandonOffered (the online payment page: "start again")', () => {
  const payer = { mine: true, noLiveAttempt: false };

  it('the payer, while the session is made or waiting at the gateway', () => {
    expect(abandonOffered(payer, 'PREPARING')).toBe(true);
    expect(abandonOffered(payer, 'READY')).toBe(true);
  });

  it('confirming: only once our own query after the last signal found nothing paid or pending (P7a2-x31)', () => {
    expect(abandonOffered(payer, 'CONFIRMING')).toBe(false);
    expect(abandonOffered({ mine: true, noLiveAttempt: true }, 'CONFIRMING')).toBe(true);
  });

  it('never for another guardian of the child, never once the payment is over', () => {
    expect(abandonOffered({ mine: false, noLiveAttempt: true }, 'CONFIRMING')).toBe(false);
    expect(abandonOffered({ mine: false, noLiveAttempt: false }, 'READY')).toBe(false);
    for (const state of ['PAID', 'CHECKING', 'NOT_PAID', 'EXPIRED', 'REFUNDED'] as const) {
      expect(abandonOffered({ mine: true, noLiveAttempt: true }, state)).toBe(false);
    }
  });
});

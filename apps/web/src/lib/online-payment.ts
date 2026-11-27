import type { OnlinePaymentState, OnlinePaymentView } from '@jantrik/shared';

/**
 * Whether the online payment page offers its payer "give up this payment" (then the sheet opens
 * to start again): while the session is made or waits at the gateway, and on "confirming" once
 * our own query after the last return or IPN found nothing paid or pending at SSLCommerz, such as
 * a cancel it lists as UNATTEMPTED or not at all (P7a2-x31). Never for another guardian of the
 * child (the API answers 404), never once the payment is over.
 */
export function abandonOffered(
  payment: Pick<OnlinePaymentView, 'mine' | 'noLiveAttempt'>,
  shown: OnlinePaymentState,
): boolean {
  if (!payment.mine) return false;
  if (shown === 'PREPARING' || shown === 'READY') return true;
  return shown === 'CONFIRMING' && payment.noLiveAttempt;
}

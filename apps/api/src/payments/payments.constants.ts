/** The payments queue (sprint 1 P7a): every call to a gateway runs in one of its jobs. */
export const PAYMENTS_QUEUE = 'payments';

/** The OWNER's connection test: `{ tenantId, accountId, actorUserId }` (ids only). */
export const ACCOUNT_TEST_JOB = 'account-test';

export interface AccountTestJobData {
  tenantId: string;
  accountId: string;
  actorUserId: string;
}

/** A new intent's gateway session (P7a2): one attempt, never retried (P7a-Q). */
export const CHECKOUT_INIT_JOB = 'checkout-init';
/** Ask the gateway about an intent's payment and settle it (jobId confirm-<intentId>). */
export const CONFIRM_JOB = 'confirm';
/** An IPN that named no intent of the institute: is it this store's money? */
export const UNMATCHED_CHECK_JOB = 'unmatched-check';

/** checkout-init and confirm: ids only (the tenant from our own records). */
export interface IntentJobData {
  tenantId: string;
  intentId: string;
}

export interface UnmatchedJobData {
  tenantId: string;
  eventId: string;
}

/** BullMQ job ids: one confirm per intent at a time (a burst of signals makes one job). */
export const initJobId = (intentId: string) => `init-${intentId}`;
export const confirmJobId = (intentId: string) => `confirm-${intentId}`;
export const unmatchedJobId = (eventId: string) => `unmatched-${eventId}`;

/** confirm: 6 attempts, from 30 s apart, doubling (about 30 minutes in all). */
export const CONFIRM_JOB_OPTS = {
  attempts: 6,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: true,
  // Removed after its last attempt too, so a later signal for the intent can queue it again.
  removeOnFail: true,
};

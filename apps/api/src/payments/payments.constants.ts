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

// ───────────────────────────── Reconciliation (P7b) ─────────────────────────────

/**
 * Ask the gateway about an intent by our tran_id (`{ tenantId, intentId, step }`): steps 1–4 at
 * +5 min, +30 min, +2 h and +25 h after the intent was created, step 5 once more at +7 days for
 * one still PENDING at +25 h (P7b-K), `manual` for "check now".
 */
export const RECONCILE_JOB = 'reconcile';
/** Every 10 minutes: re-queue the overdue steps listed in PAYMENTS_OPEN_KEY (a Redis loss). */
export const PAYMENTS_SWEEP_JOB = 'payments-sweep';

export type ReconcileStep = 1 | 2 | 3 | 4 | 5 | 'manual';
export const RECONCILE_STEPS = [1, 2, 3, 4, 5] as const;

export interface ReconcileJobData {
  tenantId: string;
  intentId: string;
  step: ReconcileStep;
}

/** When each scheduled step is due, after the intent's creation (steps 1 to 5). */
export const RECONCILE_DELAYS_MS = [
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  25 * 3_600_000,
  7 * 24 * 3_600_000,
] as const;

/** Redis sorted set: `<tenantId>:<intentId>:<step>` scored by when the step is due (ms). */
export const PAYMENTS_OPEN_KEY = 'payments:open';

export const reconcileJobId = (intentId: string, step: ReconcileStep) => `rec-${intentId}-${step}`;

/** 3 attempts from a minute apart; removed when done or failed, so the sweep can add it again. */
export const RECONCILE_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 60_000 },
  removeOnComplete: true,
  removeOnFail: true,
};

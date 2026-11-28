/** The payments queue (sprint 1 P7a): every call to a gateway runs in one of its jobs. */
export const PAYMENTS_QUEUE = 'payments';

/** The OWNER's connection test: `{ tenantId, accountId, actorUserId }` (ids only). */
export const ACCOUNT_TEST_JOB = 'account-test';

export interface AccountTestJobData {
  tenantId: string;
  accountId: string;
  actorUserId: string;
}

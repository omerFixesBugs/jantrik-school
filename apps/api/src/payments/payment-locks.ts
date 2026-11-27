import type { TenantTx } from '@jantrik/db';

/**
 * Locks of the review queue (sprint 1 P7b), taken after fee-locks.ts's steps 1 to 2a (the tenant's
 * fee lock, the student's lock, the intent's row) and before the receipt counter:
 *
 * - one payment's records (its val_id): every decision on a review event of that money takes it
 *   before it reads, and the database's commit-time check (payment_review_event_check) takes it
 *   again, so two dismissals of the two records of one payment never both pass (P7b-x);
 * - the institute's money items without a val_id (none are expected): one at a time.
 *
 * Advisory locks are database-wide, so every key includes the tenant.
 */
export async function lockPaymentMoney(tx: TenantTx, valId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('payments-val:' || app_current_tenant_id()::text || ':' || ${valId}, 0))`;
}

export async function lockPaymentSignals(tx: TenantTx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('payments-signal:' || app_current_tenant_id()::text, 0))`;
}

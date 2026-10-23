import type { TenantTx } from '@jantrik/db';

/**
 * Advisory locks of the fee module (docs/fees.md → Locks), always taken in this order so two
 * transactions never wait on each other in a cycle:
 *
 * 1. the tenant's fee lock: shared by payments, exclusive for bulk recalculation;
 * 2. one student's lock (payments, voids, waivers, cancels, verification of that student);
 * 3. one transaction ID's lock (bKash/Nagad);
 * 4. the receipt counter row (FOR UPDATE through the upsert);
 * 5. the SMS lock TenantSmsService.queue takes itself.
 *
 * Advisory locks are database-wide, so every key includes the tenant.
 */
export async function lockTenantFees(tx: TenantTx, mode: 'shared' | 'exclusive'): Promise<void> {
  if (mode === 'shared') {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('fees:' || app_current_tenant_id()::text, 0))`;
  } else {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('fees:' || app_current_tenant_id()::text, 0))`;
  }
}

export async function lockStudentFees(tx: TenantTx, studentId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('fees:' || app_current_tenant_id()::text || ':' || ${studentId}, 0))`;
}

export async function lockTrxId(tx: TenantTx, method: string, trxId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('fees-trx:' || app_current_tenant_id()::text || ':' || ${method} || ':' || ${trxId}, 0))`;
}

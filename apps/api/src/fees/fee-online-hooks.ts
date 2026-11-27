import { Injectable } from '@nestjs/common';
import type { FeeGuardianOnline } from '@jantrik/shared';

/** A gateway payment being voided: its id, child and intent (OWNER/ADMIN, docs/fees.md → Voids). */
export interface GatewayVoid {
  paymentId: string;
  studentId: string;
  paymentIntentId: string;
}

export interface FeeOnlineHookSet {
  /** The child's dues an online payment in progress names (the counter's badge). */
  pendingDueIds(studentId: string): Promise<Set<string>>;
  /** Whether a guardian can pay online, and the child's payment in progress. */
  guardianOnline(studentId: string): Promise<FeeGuardianOnline>;
  /** Our tran_id and the instrument of a gateway payment's intent (its receipt). */
  receiptOnline(paymentIntentId: string): Promise<{ tranId: string; instrument: string | null }>;
  /** In the void's transaction, with the student's lock held: the intent goes to review. */
  gatewayVoided(payment: GatewayVoid): Promise<void>;
  /**
   * The nightly fee run's visit to one institute (P7b-B): its open online payments are listed
   * for reconciliation again (a Redis loss). Outside any transaction; opens its own.
   */
  nightly(tenantId: string): Promise<void>;
}

/**
 * Where the payments module plugs into fees (sprint 1 P7a2), registered once at start like
 * `TenantSmsService.registerRelevanceCheck`: the fee module reads nothing of the payments tables
 * itself and imports nothing from that module (modules talk through service interfaces).
 * Without the payments module nothing is pending, nobody can pay online, and a gateway payment
 * cannot be voided (the database refuses a void that leaves its intent PAID).
 */
@Injectable()
export class FeeOnlineHooks {
  private hooks: FeeOnlineHookSet | null = null;

  register(hooks: FeeOnlineHookSet): void {
    this.hooks = hooks;
  }

  pendingDueIds(studentId: string): Promise<Set<string>> {
    return this.hooks ? this.hooks.pendingDueIds(studentId) : Promise.resolve(new Set());
  }

  guardianOnline(studentId: string): Promise<FeeGuardianOnline> {
    return this.hooks
      ? this.hooks.guardianOnline(studentId)
      : Promise.resolve({ available: false, inProgress: null });
  }

  receiptOnline(paymentIntentId: string): Promise<{ tranId: string; instrument: string | null }> {
    if (!this.hooks) throw new Error('The online payments module is not loaded');
    return this.hooks.receiptOnline(paymentIntentId);
  }

  gatewayVoided(payment: GatewayVoid): Promise<void> {
    if (!this.hooks) throw new Error('The online payments module is not loaded');
    return this.hooks.gatewayVoided(payment);
  }

  nightly(tenantId: string): Promise<void> {
    return this.hooks ? this.hooks.nightly(tenantId) : Promise.resolve();
  }
}

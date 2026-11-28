import { Injectable } from '@nestjs/common';
import {
  isGatewayRef,
  signalFields,
  type PaymentReviewReason,
  type SignalField,
} from '@jantrik/shared';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../common/request-context.js';
import { Db } from '../tenancy/db.service.js';
import { lockPaymentMoney } from './payment-locks.js';

/** An event outcome: an upper-case word or our fixed code (the table's CHECK). */
const OUTCOME = /^[A-Z][A-Z0-9_,]{0,39}$/;

/**
 * The API's own gateway events (INIT, VALIDATE, QUERY), in the caller's transaction (a job run by
 * TenantJobRunner). RETURN and IPN rows are written by payment_signal_record alone. Append-only;
 * every value is checked here as the table checks it, so a strange gateway answer is stored
 * without the strange parts rather than failing the job.
 */
@Injectable()
export class PaymentEventsService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly clock: Clock,
  ) {}

  async record(event: {
    intentId: string | null;
    kind: 'INIT' | 'VALIDATE' | 'QUERY';
    outcome: string;
    tranId?: string | null;
    valId?: string | null;
    fields?: Partial<Record<SignalField, string>>;
    reviewReason?: Extract<PaymentReviewReason, 'DUPLICATE' | 'UNMATCHED'> | null;
    /** When it happened, if not now (a query: when it was asked). */
    at?: Date;
  }): Promise<string> {
    const valId = isGatewayRef(event.valId) ? event.valId : null;
    let reviewReason = event.reviewReason ?? null;
    // One item of the review queue per payment (its val_id; review round 1, finding 2): signals
    // that validated the same money at once (an IPN's confirm and "check now", or step 4) each
    // record their VALIDATE event, but only the first is an item; so one payment is never put in
    // the queue twice, nor refunded outside twice. Under the payment's advisory lock, which a
    // decision on an item and the database's commit-time check take too.
    if (reviewReason && valId) {
      await lockPaymentMoney(this.db.tx, valId);
      const queued = await this.db.tx.paymentGatewayEvent.count({
        where: { kind: 'VALIDATE', valId, reviewReason: { not: null } },
      });
      if (queued > 0) reviewReason = null;
    }
    const row = await this.db.tx.paymentGatewayEvent.create({
      data: {
        tenantId: this.context.requireTenantId(),
        intentId: event.intentId,
        kind: event.kind,
        outcome: OUTCOME.test(event.outcome) ? event.outcome : 'OTHER',
        tranId: isGatewayRef(event.tranId) ? event.tranId : null,
        valId,
        fields: signalFields(event.fields ?? {}),
        reviewReason,
        receivedAt: event.at ?? this.clock.now(),
      },
      select: { id: true },
    });
    return row.id;
  }
}

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
    const row = await this.db.tx.paymentGatewayEvent.create({
      data: {
        tenantId: this.context.requireTenantId(),
        intentId: event.intentId,
        kind: event.kind,
        outcome: OUTCOME.test(event.outcome) ? event.outcome : 'OTHER',
        tranId: isGatewayRef(event.tranId) ? event.tranId : null,
        valId: isGatewayRef(event.valId) ? event.valId : null,
        fields: signalFields(event.fields ?? {}),
        reviewReason: event.reviewReason ?? null,
        receivedAt: event.at ?? this.clock.now(),
      },
      select: { id: true },
    });
    return row.id;
  }
}

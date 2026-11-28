import { InjectQueue } from '@nestjs/bullmq';
import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { withContext, type TenantTx } from '@jantrik/db';
import { isGatewayRef, signalFields, TRAN_ID_PATTERN } from '@jantrik/shared';
import type { Queue } from 'bullmq';
import { Clock } from '../../common/clock.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RateLimiter } from '../../redis/rate-limiter.service.js';
import { queueConfirm } from '../confirm-queue.js';
import { PAYMENTS_CONFIG, type PaymentsConfig } from '../payments.config.js';
import {
  PAYMENTS_QUEUE,
  UNMATCHED_CHECK_JOB,
  unmatchedJobId,
  type IntentJobData,
  type UnmatchedJobData,
} from '../payments.constants.js';

/** Institute slugs as the API makes them (lower case, digits, hyphens). */
export const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * The addresses SSLCommerz documents for its notifications (sandbox 103.26.139.87; live
 * 103.26.139.81 and 103.132.153.81; the older v3.5 page's sandbox 144.76.92.216 and .241). Not
 * enforced (P7a-C: they changed between versions of the docs): a listed sender gets a large rate
 * budget, everyone else a small one, and each event records which it was.
 */
export const SSLCOMMERZ_SOURCES: ReadonlySet<string> = new Set([
  '103.26.139.87',
  '103.26.139.81',
  '103.132.153.81',
  '144.76.92.216',
  '144.76.92.241',
]);

/** Where a payer's browser goes when this was not a return we can place: the child list. */
const DEV_WEB_URL = 'http://localhost:3000';

const LIMITS = {
  returnPerIp: { limit: 60, windowSec: 60 },
  ipnListedPerIp: { limit: 1200, windowSec: 60 },
  ipnOtherPerIp: { limit: 30, windowSec: 60 },
  ipnOtherPerInstitute: { limit: 120, windowSec: 3600 },
};

interface Recorded {
  result: 'RECORDED' | 'INVALID' | 'UNKNOWN' | 'NO_INTENT';
  tenant_id: string | null;
  event_id: string | null;
  intent_id: string | null;
  student_id: string | null;
}

const ipv4 = (ip: string) => ip.replace(/^::ffff:/, '');

/**
 * The payer's return and the IPN (sprint 1 P7a2, docs/payments.md → Signals). No institute
 * transaction is ever opened here: the signal is stored by payment_signal_record (owner
 * jantrik_payments) in a transaction with no institute and no person, and the `confirm` job asks
 * the gateway. Nothing in a signal is trusted, and nothing from a body is ever logged. Nothing in
 * this folder imports Db, TenantJobRunner or a fee service (no-tenant-access.spec.ts).
 */
@Injectable()
export class GatewaySignalsService {
  private readonly logger = new Logger(GatewaySignalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly limiter: RateLimiter,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
    @InjectQueue(PAYMENTS_QUEUE) private readonly queue: Queue,
  ) {}

  private get web(): string {
    return this.config.webPublicUrl ?? DEV_WEB_URL;
  }

  /** The function call, with no institute and no person (the public routes' only way in). */
  private record(args: {
    slug: string;
    kind: 'RETURN' | 'IPN';
    tranId: string;
    outcome: string | null;
    valId: string | null;
    fields: Record<string, string>;
    sourceListed: boolean;
  }): Promise<Recorded> {
    const now = this.clock.now();
    return withContext(
      this.prisma.client,
      {},
      async (tx: TenantTx) => {
        const [row] = await tx.$queryRaw<Recorded[]>`
          SELECT * FROM public.payment_signal_record(
            ${args.slug}, ${args.kind}, ${args.tranId}, ${args.outcome}, ${args.valId},
            ${JSON.stringify(args.fields)}::jsonb, ${args.sourceListed}, ${now}::timestamptz)`;
        return row!;
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
  }

  /** Queue what follows a stored signal; a lost job is healed later (the page, P7b). */
  private async follow(row: Recorded): Promise<void> {
    if (row.result !== 'RECORDED' || !row.tenant_id) return;
    try {
      if (row.intent_id) {
        const data: IntentJobData = { tenantId: row.tenant_id, intentId: row.intent_id };
        await queueConfirm(this.queue, data);
      } else if (row.event_id) {
        const data: UnmatchedJobData = { tenantId: row.tenant_id, eventId: row.event_id };
        await this.queue.add(UNMATCHED_CHECK_JOB, data, {
          jobId: unmatchedJobId(row.event_id),
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: 100,
        });
      }
    } catch (error) {
      this.logger.warn(`Could not queue after a gateway signal: ${(error as Error).name}`);
    }
  }

  /**
   * The payer's browser back from the gateway (POST or GET, P7a-N): where to send it (303). The
   * word in the path is stored as a hint only. Over the address's budget: still a 303, nothing
   * recorded (the payment's page heals it).
   */
  async payerReturn(
    slug: string,
    tranId: string,
    outcome: string,
    fields: Record<string, unknown> | null,
    ip: string,
  ): Promise<string> {
    const home = `${this.web}/children`;
    const word = { success: 'SUCCESS', fail: 'FAIL', cancel: 'CANCEL' }[outcome];
    if (!SLUG.test(slug) || !TRAN_ID_PATTERN.test(tranId) || !word || !fields) return home;
    const allowed = await this.limiter.tryConsume({
      key: `pay-ret-ip:${ip}`,
      ...LIMITS.returnPerIp,
    });
    if (!allowed) return home;
    const valId = isGatewayRef(fields['val_id']) ? fields['val_id'] : null;
    const row = await this.record({
      slug,
      kind: 'RETURN',
      tranId,
      outcome: word,
      valId,
      fields: signalFields(fields),
      sourceListed: SSLCOMMERZ_SOURCES.has(ipv4(ip)),
    });
    await this.follow(row);
    if (row.result !== 'RECORDED' || !row.intent_id || !row.student_id) return home;
    return `${this.web}/children/${row.student_id}/fees/pay/${row.intent_id}?from=gateway`;
  }

  /**
   * SSLCommerz's notification: always 200 unless over a budget (429), for an unknown institute or
   * intent too (a public slug list says as much). Listed senders get a large budget; any other
   * sender a small one per address and, once its body parsed, one per institute.
   */
  async ipn(slug: string, fields: Record<string, unknown> | null, ip: string): Promise<void> {
    const listed = SSLCOMMERZ_SOURCES.has(ipv4(ip));
    const perIp = listed ? LIMITS.ipnListedPerIp : LIMITS.ipnOtherPerIp;
    if (!(await this.limiter.tryConsume({ key: `pay-ipn-ip:${ip}`, ...perIp }))) {
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    // A malformed notification: OK, nothing stored, and no institute budget spent.
    if (!SLUG.test(slug) || !fields || !isGatewayRef(fields['tran_id'])) return;
    if (
      !listed &&
      !(await this.limiter.tryConsume({
        key: `pay-ipn-tenant:${slug}`,
        ...LIMITS.ipnOtherPerInstitute,
      }))
    ) {
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    const row = await this.record({
      slug,
      kind: 'IPN',
      tranId: fields['tran_id'],
      outcome: null,
      valId: isGatewayRef(fields['val_id']) ? fields['val_id'] : null,
      fields: signalFields(fields),
      sourceListed: listed,
    });
    await this.follow(row);
  }
}

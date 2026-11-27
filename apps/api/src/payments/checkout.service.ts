import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import {
  dateToDb,
  newTranId,
  ONLINE_INTENT_MINUTES,
  ONLINE_MAX_PAISA,
  ONLINE_MIN_PAISA,
  onlinePaymentState,
  receiptNumber,
  type FeeGuardianOnline,
  type OnlinePaymentView,
  type StartOnlinePaymentInput,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../common/request-context.js';
import { FeeCollectionService } from '../fees/collection/fee-collection.service.js';
import { FeeDuesService } from '../fees/dues/fee-dues.service.js';
import { lockPaymentIntent, lockStudentFees, lockTenantFees } from '../fees/fee-locks.js';
import { FeeMobileService } from '../fees/mobile/fee-mobile.service.js';
import { RateLimiter } from '../redis/rate-limiter.service.js';
import { Db } from '../tenancy/db.service.js';
import { TenantJobRunner } from '../tenancy/tenant-job-runner.service.js';
import {
  PaymentCredentialsError,
  PaymentCredentialsService,
} from './payment-credentials.service.js';
import { PaymentEventsService } from './payment-events.service.js';
import { ipnUrl, PAYMENTS_CONFIG, returnUrl, type PaymentsConfig } from './payments.config.js';
import { queueConfirm } from './confirm-queue.js';
import {
  CHECKOUT_INIT_JOB,
  initJobId,
  PAYMENTS_QUEUE,
  type IntentJobData,
} from './payments.constants.js';
import {
  PAYMENT_PROVIDER,
  PROVIDER_ERROR_CODES,
  queryFoundNothingLive,
  type CheckoutRequest,
  type PaymentProvider,
} from './provider.js';

const PROVIDER = 'SSLCOMMERZ' as const;
const ENTITY = 'payment_intent';
/** Checkouts a guardian may start per hour. */
const STARTS_PER_HOUR = 10;
/** An open intent older than this is asked about again when its page is read (heal on read). */
const HEAL_AFTER_MS = 60_000;
/** SSLCommerz needs an email; guardians are not asked for one (P7a-K). */
const PAYER_EMAIL = 'noreply@jantrik.com.bd';

const OPEN = ['CREATED', 'REDIRECTED'] as const;

const viewInclude = {
  dues: {
    orderBy: { createdAt: 'asc' },
    select: {
      plannedPrincipalPaisa: true,
      plannedFinePaisa: true,
      due: {
        select: {
          id: true,
          periodKey: true,
          dueDate: true,
          feeHead: { select: { nameBn: true, nameEn: true, sortOrder: true } },
          feeTerm: { select: { nameBn: true, nameEn: true } },
        },
      },
    },
  },
  feePayment: { select: { id: true, receiptYear: true, receiptNo: true } },
  events: { where: { kind: { in: ['RETURN', 'IPN'] } }, select: { id: true }, take: 1 },
} satisfies Prisma.PaymentIntentInclude;
type IntentRow = Prisma.PaymentIntentGetPayload<{ include: typeof viewInclude }>;

/** Printable ASCII only, trimmed and cut: what SSLCommerz is sent about the payer. */
const ascii = (value: string | null | undefined, max: number): string | null => {
  const v = (value ?? '').replace(/\s+/g, ' ').trim();
  return v && /^[\x20-\x7e]+$/.test(v) ? v.slice(0, max) : null;
};

/**
 * Guardians pay chosen dues of their child in full through SSLCommerz (sprint 1 P7a2, S22,
 * docs/payments.md → Checkout): the server computes the amount as the counter does and keeps what
 * each due owed (the snapshot), at most one payment in progress per child (P7a-F), and the
 * gateway session is made in a job (no call to the gateway inside a request).
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly limiter: RateLimiter,
    private readonly dues: FeeDuesService,
    private readonly collection: FeeCollectionService,
    private readonly mobile: FeeMobileService,
    private readonly jobs: TenantJobRunner,
    private readonly credentials: PaymentCredentialsService,
    private readonly events: PaymentEventsService,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @InjectQueue(PAYMENTS_QUEUE) private readonly queue: Queue,
  ) {}

  /** The institute's account, when online payments are on and the server has its addresses. */
  private async liveAccount(): Promise<{ id: string } | null> {
    if (!this.config.apiPublicUrl || !this.config.webPublicUrl) return null;
    const account = await this.db.tx.paymentGatewayAccount.findUnique({
      where: {
        tenantId_provider: { tenantId: this.context.requireTenantId(), provider: PROVIDER },
      },
      select: { id: true, enabled: true },
    });
    return account?.enabled ? { id: account.id } : null;
  }

  /** The child's payment started less than an hour ago and not finished, if any. */
  private openIntent(studentId: string) {
    return this.db.tx.paymentIntent.findFirst({
      where: { studentId, status: { in: [...OPEN] }, expiresAt: { gt: this.clock.now() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, payerUserId: true, createdAt: true },
    });
  }

  /** For the guardian's fees page (FeeOnlineHooks.guardianOnline). */
  async guardianOnline(studentId: string): Promise<FeeGuardianOnline> {
    const [account, open] = await Promise.all([this.liveAccount(), this.openIntent(studentId)]);
    const me = this.context.requirePrincipal().userId;
    return {
      available: account !== null,
      inProgress: open
        ? {
            intentId: open.id,
            mine: open.payerUserId === me,
            createdAt: open.createdAt.toISOString(),
          }
        : null,
    };
  }

  /** The dues an open, unexpired intent names (the counter's badge, FeeOnlineHooks). */
  async pendingDueIds(studentId: string): Promise<Set<string>> {
    const rows = await this.db.tx.paymentIntentDue.findMany({
      where: {
        studentId,
        intent: { status: { in: [...OPEN] }, expiresAt: { gt: this.clock.now() } },
      },
      select: { dueId: true },
    });
    return new Set(rows.map((r) => r.dueId));
  }

  /** POST /me/children/:id/fees/online-payments (S22: the dues in full, the amount ours). */
  async start(studentId: string, input: StartOnlinePaymentInput): Promise<OnlinePaymentView> {
    const tx = this.db.tx;
    await this.mobile.assertChild(studentId);
    const account = await this.liveAccount();
    if (!account) {
      throw apiError(422, 'ONLINE_PAYMENTS_OFF', 'Online payment is not available here');
    }
    const me = this.context.requirePrincipal().userId;
    await this.limiter.consumeIfAllowed({
      key: `pay-start:${me}`,
      limit: STARTS_PER_HOUR,
      windowSec: 3600,
    });
    await lockTenantFees(tx, 'shared');
    await lockStudentFees(tx, studentId);

    // A retry whose answer was lost gets the same payment; the id used for anything else: 422.
    const previous = await tx.paymentIntent.findFirst({
      where: { clientRequestId: input.clientRequestId },
      include: viewInclude,
    });
    if (previous) {
      const ids = new Set(previous.dues.map((d) => d.due.id));
      const same =
        previous.payerUserId === me &&
        previous.studentId === studentId &&
        ids.size === input.dueIds.length &&
        input.dueIds.every((id) => ids.has(id));
      if (!same) {
        throw apiError(422, 'IDEMPOTENCY_MISMATCH', 'This request id was used for another payment');
      }
      return this.toView(previous, me);
    }

    // One payment in progress per child (P7a-F); who started it is not said.
    const open = await this.openIntent(studentId);
    if (open) {
      throw apiError(409, 'PAYMENT_IN_PROGRESS', 'A payment for this child is in progress', {
        intentId: open.id,
        mine: open.payerUserId === me,
      });
    }

    const ctx = await this.dues.planContext();
    await this.dues.ensureForStudents([studentId], { ctx });
    const rows = await this.collection.openDues(studentId, input.dueIds);
    const owed = rows.map((row) => ({ row, owed: this.collection.owedOn(row, ctx.today) }));
    if (owed.some((d) => d.owed.total <= 0)) {
      throw apiError(422, 'NOTHING_DUE', 'Nothing is owed on one of these dues');
    }
    const amountPaisa = owed.reduce((sum, d) => sum + d.owed.total, 0);
    if (amountPaisa !== input.expectedAmountPaisa) {
      throw apiError(409, 'DUES_CHANGED', 'These dues changed: check the amount again', {
        amountPaisa,
      });
    }
    if (amountPaisa < ONLINE_MIN_PAISA || amountPaisa > ONLINE_MAX_PAISA) {
      throw apiError(422, 'ONLINE_AMOUNT_OUT_OF_RANGE', 'This amount cannot be paid online', {
        minPaisa: ONLINE_MIN_PAISA,
        maxPaisa: ONLINE_MAX_PAISA,
      });
    }

    const tenantId = this.context.requireTenantId();
    const now = this.clock.now();
    const tranId = newTranId(now);
    const intent = await tx.paymentIntent.create({
      data: {
        tenantId,
        accountId: account.id,
        studentId,
        payerUserId: me,
        amountPaisa,
        pricedOn: dateToDb(ctx.today),
        tranId,
        clientRequestId: input.clientRequestId,
        expiresAt: new Date(now.getTime() + ONLINE_INTENT_MINUTES * 60_000),
        createdAt: now,
      },
      select: { id: true },
    });
    await tx.paymentIntentDue.createMany({
      data: owed.map(({ row, owed: o }) => ({
        tenantId,
        intentId: intent.id,
        studentId,
        dueId: row.id,
        plannedPrincipalPaisa: o.principal,
        plannedFinePaisa: o.fine,
      })),
    });
    await this.audit.record({
      entity: ENTITY,
      entityId: intent.id,
      action: 'CREATE',
      newValues: {
        amountPaisa,
        tranId,
        pricedOn: ctx.today,
        dues: owed.map(({ row, owed: o }) => ({
          dueId: row.id,
          principalPaisa: o.principal,
          finePaisa: o.fine,
        })),
      },
    });
    const data: IntentJobData = { tenantId, intentId: intent.id };
    await this.context.afterCommit(() =>
      this.queue.add(CHECKOUT_INIT_JOB, data, {
        jobId: initJobId(intent.id),
        // One attempt: a retry would reuse the tran_id with a session that may exist (P7a-Q).
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 100,
      }),
    );
    return this.view(studentId, intent.id, { heal: false });
  }

  /** GET …/online-payments/:intentId: any guardian of the child; the gateway page for the payer. */
  async view(
    studentId: string,
    intentId: string,
    opts: { heal?: boolean } = {},
  ): Promise<OnlinePaymentView> {
    await this.mobile.assertChild(studentId);
    const row = await this.db.tx.paymentIntent.findFirst({
      where: { id: intentId, studentId },
      include: viewInclude,
    });
    if (!row) throw new NotFoundException('Payment not found');
    const open = (OPEN as readonly string[]).includes(row.status);
    if (
      opts.heal !== false &&
      open &&
      this.clock.now().getTime() - row.createdAt.getTime() > HEAL_AFTER_MS
    ) {
      // Heal on read: a lost signal or job is asked about again, at most once a minute, by a job.
      const allowed = await this.limiter.tryConsume({
        key: `pay-heal:${row.id}`,
        limit: 1,
        windowSec: 60,
      });
      if (allowed) {
        const data: IntentJobData = { tenantId: row.tenantId, intentId: row.id };
        // Queued once the read commits, and the read does not wait for it: a guardian's read
        // never waits on the queue, let alone on SSLCommerz (only the job asks it).
        await this.context.afterCommit(() => {
          void queueConfirm(this.queue, data).catch((error: unknown) =>
            this.logger.warn(`Could not queue a heal: ${(error as Error).name}`),
          );
        });
      }
    }
    return this.toView(row, this.context.requirePrincipal().userId);
  }

  /** POST …/:intentId/abandon: the payer gives up an open payment ("start again"). */
  async abandon(studentId: string, intentId: string): Promise<OnlinePaymentView> {
    const tx = this.db.tx;
    await this.mobile.assertChild(studentId);
    const me = this.context.requirePrincipal().userId;
    const found = await tx.paymentIntent.findFirst({
      where: { id: intentId, studentId, payerUserId: me },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Payment not found');
    await lockTenantFees(tx, 'shared');
    await lockStudentFees(tx, studentId);
    await lockPaymentIntent(tx, intentId);
    const intent = await tx.paymentIntent.findUniqueOrThrow({
      where: { id: intentId },
      select: { status: true },
    });
    if (!(OPEN as readonly string[]).includes(intent.status)) {
      throw apiError(409, 'NOT_ABANDONABLE', 'This payment is no longer in progress');
    }
    await tx.paymentIntent.update({
      where: { id: intentId },
      data: { status: 'CANCELLED', closedAt: this.clock.now() },
      select: { id: true },
    });
    await this.audit.record({
      entity: ENTITY,
      entityId: intentId,
      action: 'UPDATE',
      oldValues: { status: intent.status },
      newValues: { status: 'CANCELLED', by: 'PAYER' },
    });
    return this.view(studentId, intentId, { heal: false });
  }

  /**
   * Whether our own query by tran_id, asked since the last return or IPN, listed no paid or
   * pending attempt (P7a2-x31): the payer may then start again from "confirming". A query that
   * failed answered nothing; a signal after the query is not answered for yet.
   */
  private async noLiveAttempt(intentId: string): Promise<boolean> {
    const tx = this.db.tx;
    const signal = await tx.paymentGatewayEvent.findFirst({
      where: { intentId, kind: { in: ['RETURN', 'IPN'] } },
      orderBy: { receivedAt: 'desc' },
      select: { receivedAt: true },
    });
    const query = await tx.paymentGatewayEvent.findFirst({
      where: { intentId, kind: 'QUERY', outcome: { notIn: [...PROVIDER_ERROR_CODES] } },
      orderBy: { receivedAt: 'desc' },
      select: { outcome: true, receivedAt: true },
    });
    if (!query || (signal && signal.receivedAt > query.receivedAt)) return false;
    return queryFoundNothingLive(query.outcome);
  }

  private async toView(row: IntentRow, me: string): Promise<OnlinePaymentView> {
    const state = onlinePaymentState(row.status, row.events.length > 0);
    const mine = row.payerUserId === me;
    return {
      id: row.id,
      state,
      amountPaisa: row.amountPaisa,
      dues: [...row.dues]
        .sort(
          (a, b) =>
            a.due.dueDate.getTime() - b.due.dueDate.getTime() ||
            a.due.feeHead.sortOrder - b.due.feeHead.sortOrder,
        )
        .map((d) => ({
          id: d.due.id,
          head: { nameBn: d.due.feeHead.nameBn, nameEn: d.due.feeHead.nameEn },
          periodKey: d.due.periodKey,
          term: d.due.feeTerm,
          principalPaisa: d.plannedPrincipalPaisa,
          finePaisa: d.plannedFinePaisa,
        })),
      createdAt: row.createdAt.toISOString(),
      tranId: row.tranId,
      mine,
      noLiveAttempt: row.status === 'REDIRECTED' ? await this.noLiveAttempt(row.id) : false,
      ...(mine && state === 'READY' && row.checkoutUrl ? { checkoutUrl: row.checkoutUrl } : {}),
      ...(row.status === 'PAID' && row.feePayment
        ? {
            receipt: {
              id: row.feePayment.id,
              receiptNumber: receiptNumber(row.feePayment.receiptYear, row.feePayment.receiptNo),
            },
          }
        : {}),
    };
  }

  // ─────────────────────────── The checkout-init job ───────────────────────────

  /**
   * Make the intent's gateway session: read what it needs in one short transaction, ask
   * SSLCommerz outside any transaction (one attempt, P7a-Q), then record the answer under the
   * student's lock and the intent's row lock. An intent abandoned meanwhile stays abandoned.
   */
  async runInit(data: IntentJobData): Promise<void> {
    const read = await this.jobs.run(data.tenantId, async () => {
      const tx = this.db.tx;
      const intent = await tx.paymentIntent.findUnique({
        where: { id: data.intentId },
        select: {
          id: true,
          status: true,
          tranId: true,
          amountPaisa: true,
          studentId: true,
          payerUserId: true,
          accountId: true,
          account: { select: { enabled: true } },
        },
      });
      if (!intent || intent.status !== 'CREATED') return null;
      if (!intent.account.enabled || !this.config.apiPublicUrl) {
        return { intent, creds: null, failure: 'ONLINE_PAYMENTS_OFF' as const };
      }
      let creds;
      try {
        creds = await this.credentials.read(intent.accountId);
      } catch (error) {
        if (!(error instanceof PaymentCredentialsError)) throw error;
        return { intent, creds: null, failure: error.code };
      }
      const [tenant, guardian, profile] = await Promise.all([
        tx.tenant.findFirstOrThrow({ select: { slug: true } }),
        tx.guardian.findFirst({
          where: {
            userId: intent.payerUserId,
            students: { some: { studentId: intent.studentId } },
          },
          select: { nameEn: true, phone: true },
        }),
        tx.instituteProfile.findFirst({ select: { addressEn: true } }),
      ]);
      return { intent, creds, failure: null, tenant, guardian, profile };
    });
    if (!read) return;

    let result: Awaited<ReturnType<PaymentProvider['createCheckout']>>;
    if (!read.creds || !('tenant' in read)) {
      result = { kind: 'ERROR', code: 'INVALID_REQUEST' };
    } else {
      const api = this.config.apiPublicUrl!;
      const slug = read.tenant!.slug;
      const tranId = read.intent.tranId;
      const request: CheckoutRequest = {
        tranId,
        amountPaisa: read.intent.amountPaisa,
        intentId: read.intent.id,
        urls: {
          success: returnUrl(api, slug, tranId, 'success'),
          fail: returnUrl(api, slug, tranId, 'fail'),
          cancel: returnUrl(api, slug, tranId, 'cancel'),
          ipn: ipnUrl(api, slug),
        },
        // The payer (P7a-K): the guardian as the institute recorded them, never the child.
        customer: {
          name: ascii(read.guardian?.nameEn, 50) ?? 'Guardian',
          phone: (read.guardian?.phone ?? '').replace(/^\+88/, '') || 'N/A',
          email: PAYER_EMAIL,
          address: ascii(read.profile?.addressEn, 100) ?? 'N/A',
          city: 'N/A',
          postcode: 'N/A',
          country: 'Bangladesh',
        },
      };
      result = await this.provider.createCheckout(read.creds, request);
    }
    const failure = read.failure ?? (result.kind === 'ERROR' ? result.code : null);

    await this.jobs.run(data.tenantId, async () => {
      const tx = this.db.tx;
      const now = this.clock.now();
      await lockTenantFees(tx, 'shared');
      await lockStudentFees(tx, read.intent.studentId);
      await lockPaymentIntent(tx, read.intent.id);
      await this.events.record({
        intentId: read.intent.id,
        kind: 'INIT',
        outcome: failure ?? 'OK',
        tranId: read.intent.tranId,
      });
      // The owner sees the last failure on the settings page (not for an account they turned off).
      if (failure && failure !== 'ONLINE_PAYMENTS_OFF') {
        await tx.paymentGatewayAccount.update({
          where: { id: read.intent.accountId },
          data: { lastFailureCode: failure, lastFailureAt: now },
          select: { id: true },
        });
      }
      const { count } = await tx.paymentIntent.updateMany({
        where: { id: read.intent.id, status: 'CREATED' },
        data:
          result.kind === 'OK' && !failure
            ? {
                status: 'REDIRECTED',
                sessionRef: result.sessionRef,
                checkoutUrl: result.redirectUrl,
              }
            : { status: 'FAILED', initError: failure ?? 'BAD_RESPONSE', closedAt: now },
      });
      if (count === 1) {
        await this.audit.record({
          entity: ENTITY,
          entityId: read.intent.id,
          action: 'UPDATE',
          oldValues: { status: 'CREATED' },
          newValues: failure ? { status: 'FAILED', initError: failure } : { status: 'REDIRECTED' },
        });
      }
    });
  }
}

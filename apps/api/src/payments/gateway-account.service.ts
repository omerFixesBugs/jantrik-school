import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type {
  GatewayAccountView,
  GatewayTestQueued,
  GatewayTestResult,
  SslcommerzCredentials,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { Clock } from '../common/clock.js';
import { RequestContext } from '../common/request-context.js';
import { RateLimiter } from '../redis/rate-limiter.service.js';
import { Db } from '../tenancy/db.service.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';
import { TenantJobRunner } from '../tenancy/tenant-job-runner.service.js';
import {
  PaymentCredentialsError,
  PaymentCredentialsService,
} from './payment-credentials.service.js';
import { ipnUrl, PAYMENTS_CONFIG, type PaymentsConfig } from './payments.config.js';
import { ACCOUNT_TEST_JOB, PAYMENTS_QUEUE, type AccountTestJobData } from './payments.constants.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './provider.js';

const PROVIDER = 'SSLCOMMERZ' as const;
const ENTITY = 'payment_gateway_account';
/** Connection tests per institute and hour (each one calls SSLCommerz). */
const TESTS_PER_HOUR = 10;

/** What the view reads: never the ciphertext (the credentials service alone asks for it). */
const VIEW_SELECT = {
  id: true,
  enabled: true,
  credentialsHint: true,
  credentialsUpdatedAt: true,
  lastTestAt: true,
  lastTestResult: true,
  lastFailureCode: true,
  lastFailureAt: true,
} as const;

/**
 * The institute's SSLCommerz account (sprint 1 P7a, docs/payments.md → Gateway accounts): the
 * OWNER saves the store ID and password (write-only), tests them (a queue job: no call to the
 * gateway inside a request), and switches the account on only after a passing test (P7a-M).
 * Every change is audited by field name, never a value.
 */
@Injectable()
export class GatewayAccountService {
  constructor(
    private readonly db: Db,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
    private readonly credentials: PaymentCredentialsService,
    private readonly jobs: TenantJobRunner,
    private readonly access: TenantAccessService,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @InjectQueue(PAYMENTS_QUEUE) private readonly queue: Queue,
  ) {}

  private find() {
    return this.db.tx.paymentGatewayAccount.findUnique({
      where: {
        tenantId_provider: { tenantId: this.context.requireTenantId(), provider: PROVIDER },
      },
      select: VIEW_SELECT,
    });
  }

  async view(): Promise<GatewayAccountView> {
    const [account, tenant] = await Promise.all([
      this.find(),
      this.db.tx.tenant.findFirstOrThrow({ select: { slug: true } }),
    ]);
    const lastTest =
      account?.lastTestAt && account.lastTestResult
        ? {
            at: account.lastTestAt.toISOString(),
            result: account.lastTestResult as GatewayTestResult,
          }
        : null;
    return {
      provider: PROVIDER,
      mode: 'SANDBOX',
      configured: Boolean(account?.credentialsHint),
      enabled: account?.enabled ?? false,
      hint: account?.credentialsHint ?? null,
      credentialsUpdatedAt: account?.credentialsUpdatedAt?.toISOString() ?? null,
      lastTest,
      lastFailure:
        account?.lastFailureCode && account.lastFailureAt
          ? { at: account.lastFailureAt.toISOString(), code: account.lastFailureCode }
          : null,
      ipnUrl: this.config.apiPublicUrl ? ipnUrl(this.config.apiPublicUrl, tenant.slug) : null,
    };
  }

  /** New credentials: saved encrypted, the account off and untested until a new test passes. */
  async saveCredentials(input: SslcommerzCredentials): Promise<GatewayAccountView> {
    const tenantId = this.context.requireTenantId();
    const existing = await this.find();
    const account =
      existing ??
      (await this.db.tx.paymentGatewayAccount.create({
        data: { tenantId, provider: PROVIDER },
        select: VIEW_SELECT,
      }));
    await this.credentials.save(account.id, input, {
      actorUserId: this.context.requirePrincipal().userId,
      now: this.clock.now(),
    });
    await this.audit.record({
      entity: ENTITY,
      entityId: account.id,
      action: existing ? 'UPDATE' : 'CREATE',
      ...(existing ? { oldValues: { enabled: existing.enabled } } : {}),
      // Field names only (review focus 6): never a value, not even the hint.
      newValues: { changed: ['storeId', 'storePassword'], enabled: false },
    });
    return this.view();
  }

  /** Queue a connection test (202); its result arrives on the view. */
  async requestTest(): Promise<GatewayTestQueued> {
    const tenantId = this.context.requireTenantId();
    const account = await this.find();
    if (!account?.credentialsHint) {
      throw apiError(422, 'CREDENTIALS_REQUIRED', 'Save the store ID and password first');
    }
    await this.limiter.consumeIfAllowed({
      key: `pay-test:${tenantId}`,
      limit: TESTS_PER_HOUR,
      windowSec: 3600,
    });
    const data: AccountTestJobData = {
      tenantId,
      accountId: account.id,
      actorUserId: this.context.requirePrincipal().userId,
    };
    const requestedAt = this.clock.now();
    await this.context.afterCommit(() =>
      this.queue.add(ACCOUNT_TEST_JOB, data, {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 100,
      }),
    );
    return { requestedAt: requestedAt.toISOString() };
  }

  async enable(): Promise<GatewayAccountView> {
    const account = await this.find();
    if (!account?.credentialsHint || account.lastTestResult !== 'OK') {
      throw apiError(422, 'TEST_REQUIRED', 'Test the connection first; it must pass');
    }
    if (!this.config.apiPublicUrl) {
      throw apiError(
        422,
        'API_PUBLIC_URL_MISSING',
        'The server has no public address yet (API_PUBLIC_URL): SSLCommerz could not reach it',
      );
    }
    if (!account.enabled) {
      // Conditional: credentials saved meanwhile cleared the test, and then nothing changes.
      const { count } = await this.db.tx.paymentGatewayAccount.updateMany({
        where: { id: account.id, enabled: false, lastTestResult: 'OK' },
        data: { enabled: true },
      });
      if (count === 0) {
        throw apiError(422, 'TEST_REQUIRED', 'Test the connection first; it must pass');
      }
      await this.audit.record({
        entity: ENTITY,
        entityId: account.id,
        action: 'UPDATE',
        oldValues: { enabled: false },
        newValues: { enabled: true },
      });
    }
    return this.view();
  }

  async disable(): Promise<GatewayAccountView> {
    const account = await this.find();
    if (account?.enabled) {
      await this.db.tx.paymentGatewayAccount.update({
        where: { id: account.id },
        data: { enabled: false },
        select: { id: true },
      });
      await this.audit.record({
        entity: ENTITY,
        entityId: account.id,
        action: 'UPDATE',
        oldValues: { enabled: true },
        newValues: { enabled: false },
      });
    }
    return this.view();
  }

  /**
   * The `account-test` job: read and decrypt in one short transaction, ask SSLCommerz outside any
   * transaction, then record the result in another, acting as the owner who asked (audit names
   * them). Nothing is recorded when they are no longer the owner, or when the credentials were
   * replaced meanwhile (a result must belong to what was tested). A failed test switches an
   * account that was on off: on only with a passing test (the database CHECK says the same).
   */
  async runTest(data: AccountTestJobData): Promise<void> {
    const stillOwner = async () =>
      (await this.access.getRoles(data.tenantId, data.actorUserId)).includes('OWNER');
    if (!(await stillOwner())) return;
    const opts = { actorUserId: data.actorUserId };
    const read = await this.jobs.run(
      data.tenantId,
      async () => {
        const account = await this.db.tx.paymentGatewayAccount.findUnique({
          where: { id: data.accountId },
          select: { id: true, credentialsUpdatedAt: true },
        });
        if (!account?.credentialsUpdatedAt) return null;
        try {
          const creds = await this.credentials.read(account.id);
          return { savedAt: account.credentialsUpdatedAt, creds, failure: null };
        } catch (error) {
          if (!(error instanceof PaymentCredentialsError)) throw error;
          return { savedAt: account.credentialsUpdatedAt, creds: null, failure: error.code };
        }
      },
      opts,
    );
    if (!read) return;
    const result: GatewayTestResult = read.creds
      ? await this.provider.testConnection(read.creds)
      : 'ERROR';
    // The test may take up to 30 s: they must still be the owner when it is recorded.
    if (!(await stillOwner())) return;
    await this.jobs.run(
      data.tenantId,
      async () => {
        const now = this.clock.now();
        const account = await this.db.tx.paymentGatewayAccount.findUnique({
          where: { id: data.accountId },
          select: { id: true, enabled: true, credentialsUpdatedAt: true },
        });
        if (account?.credentialsUpdatedAt?.getTime() !== read.savedAt.getTime()) return;
        const switchOff = account.enabled && result !== 'OK';
        const { count } = await this.db.tx.paymentGatewayAccount.updateMany({
          where: { id: account.id, credentialsUpdatedAt: read.savedAt },
          data: {
            lastTestAt: now,
            lastTestResult: result,
            lastTestedById: data.actorUserId,
            ...(switchOff ? { enabled: false } : {}),
            ...(read.failure ? { lastFailureCode: read.failure, lastFailureAt: now } : {}),
          },
        });
        if (count === 0) return;
        await this.audit.record({
          entity: ENTITY,
          entityId: account.id,
          action: 'UPDATE',
          newValues: switchOff ? { test: result, enabled: false } : { test: result },
        });
      },
      opts,
    );
  }
}

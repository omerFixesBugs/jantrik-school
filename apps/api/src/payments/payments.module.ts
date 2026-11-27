import { BullModule, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Module,
  Post,
  Put,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  sslcommerzCredentialsSchema,
  type GatewayAccountView,
  type GatewayTestQueued,
} from '@jantrik/shared';
import type { Job } from 'bullmq';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import type { Env } from '../config/env.js';
import { FeeOnlineHooks } from '../fees/fee-online-hooks.js';
import { FeesModule } from '../fees/fees.module.js';
import { CheckoutService } from './checkout.service.js';
import { ConfirmService, PaymentJobError } from './confirm.service.js';
import { GatewayAccountService } from './gateway-account.service.js';
import { GuardianPaymentsController } from './guardian-payments.controller.js';
import { PaymentCredentialsService } from './payment-credentials.service.js';
import { PaymentEventsService } from './payment-events.service.js';
import { PAYMENTS_CONFIG, paymentsConfig } from './payments.config.js';
import {
  ACCOUNT_TEST_JOB,
  CHECKOUT_INIT_JOB,
  CONFIRM_JOB,
  PAYMENTS_QUEUE,
  PAYMENTS_SWEEP_JOB,
  RECONCILE_JOB,
  UNMATCHED_CHECK_JOB,
  type AccountTestJobData,
  type IntentJobData,
  type ReconcileJobData,
  type UnmatchedJobData,
} from './payments.constants.js';
import { PAYMENT_PROVIDER } from './provider.js';
import { GatewaySignalsController } from './public/gateway-signals.controller.js';
import { GatewaySignalsService } from './public/gateway-signals.service.js';
import { ReconcileJobError, ReconcileQueue, ReconcileService } from './reconcile.service.js';
import { SettleService } from './settle.service.js';
import { SslcommerzProvider } from './sslcommerz/sslcommerz.provider.js';

class SslcommerzCredentialsDto extends zodDto(sslcommerzCredentialsSchema) {}

/**
 * The institute's SSLCommerz account (docs/payments.md → Gateway accounts): the OWNER only (where
 * money goes), and only with the fee module on.
 */
@Controller('fees/online-payments/account')
@RequireModule('FEES')
@Roles('OWNER')
export class GatewayAccountController {
  constructor(private readonly accounts: GatewayAccountService) {}

  @Get()
  view(): Promise<GatewayAccountView> {
    return this.accounts.view();
  }

  /** Write-only: the values never come back, in this answer or any other. */
  @Put()
  save(@Body() dto: SslcommerzCredentialsDto): Promise<GatewayAccountView> {
    return this.accounts.saveCredentials(dto);
  }

  @Post('test')
  @HttpCode(202)
  test(): Promise<GatewayTestQueued> {
    return this.accounts.requestTest();
  }

  @Post('enable')
  @HttpCode(200)
  enable(): Promise<GatewayAccountView> {
    return this.accounts.enable();
  }

  @Post('disable')
  @HttpCode(200)
  disable(): Promise<GatewayAccountView> {
    return this.accounts.disable();
  }
}

/**
 * The payments queue's jobs (data: ids only). A failure is logged by job name and error name
 * only: a gateway's answer, a URL or a credential never reaches a log line or a failed job. Only
 * `confirm` and `reconcile` fail their job (a fixed code), so BullMQ retries them.
 */
@Processor(PAYMENTS_QUEUE)
export class PaymentsProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentsProcessor.name);

  constructor(
    private readonly accounts: GatewayAccountService,
    private readonly checkout: CheckoutService,
    private readonly confirm: ConfirmService,
    private readonly reconcile: ReconcileService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    try {
      switch (job.name) {
        case ACCOUNT_TEST_JOB:
          await this.accounts.runTest(job.data as AccountTestJobData);
          break;
        case CHECKOUT_INIT_JOB:
          await this.checkout.runInit(job.data as IntentJobData);
          break;
        case CONFIRM_JOB:
          await this.confirm.run(job.data as IntentJobData);
          break;
        case UNMATCHED_CHECK_JOB:
          await this.confirm.unmatchedCheck(job.data as UnmatchedJobData);
          break;
        case RECONCILE_JOB:
          await this.reconcile.run(job.data as ReconcileJobData);
          break;
        case PAYMENTS_SWEEP_JOB:
          await this.reconcile.sweep();
          break;
      }
    } catch (error) {
      this.logger.error(`Payments job ${job.name} failed: ${(error as Error).name}`);
      if (job.name === CONFIRM_JOB) {
        // Retried with a fixed code only (never the error itself: it could carry an answer).
        throw error instanceof PaymentJobError ? error : new Error('CONFIRM_FAILED');
      }
      if (job.name === RECONCILE_JOB) {
        // Retried (3 attempts); after the last one the step stays listed for the sweep.
        throw error instanceof PaymentJobError || error instanceof ReconcileJobError
          ? error
          : new Error('RECONCILE_FAILED');
      }
    }
  }
}

@Module({
  imports: [BullModule.registerQueue({ name: PAYMENTS_QUEUE }), FeesModule],
  controllers: [GatewayAccountController, GuardianPaymentsController, GatewaySignalsController],
  providers: [
    {
      provide: PAYMENTS_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => paymentsConfig(config),
    },
    SslcommerzProvider,
    { provide: PAYMENT_PROVIDER, useExisting: SslcommerzProvider },
    PaymentCredentialsService,
    GatewayAccountService,
    PaymentEventsService,
    CheckoutService,
    SettleService,
    ConfirmService,
    ReconcileQueue,
    ReconcileService,
    GatewaySignalsService,
    PaymentsProcessor,
  ],
  exports: [
    PaymentCredentialsService,
    PAYMENT_PROVIDER,
    PAYMENTS_CONFIG,
    ConfirmService,
    SettleService,
    CheckoutService,
  ],
})
export class PaymentsModule implements OnModuleInit {
  constructor(
    private readonly hooks: FeeOnlineHooks,
    private readonly checkout: CheckoutService,
    private readonly settle: SettleService,
    private readonly reconcile: ReconcileService,
  ) {}

  /**
   * The module's part in fees (FeeOnlineHooks), registered once at start: the counter's "online
   * payment in progress", the guardian's "pay online", a gateway receipt's online part, and a
   * void sending the intent back to review.
   */
  onModuleInit(): void {
    this.hooks.register({
      pendingDueIds: (studentId) => this.checkout.pendingDueIds(studentId),
      guardianOnline: (studentId) => this.checkout.guardianOnline(studentId),
      receiptOnline: (intentId) => this.settle.receiptOnline(intentId),
      gatewayVoided: (payment) => this.settle.gatewayVoided(payment),
      nightly: (tenantId) => this.reconcile.requeueTenant(tenantId),
    });
  }
}

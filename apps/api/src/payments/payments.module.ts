import { BullModule, Processor, WorkerHost } from '@nestjs/bullmq';
import { Body, Controller, Get, HttpCode, Logger, Module, Post, Put } from '@nestjs/common';
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
import { GatewayAccountService } from './gateway-account.service.js';
import { PaymentCredentialsService } from './payment-credentials.service.js';
import { PAYMENTS_CONFIG, paymentsConfig } from './payments.config.js';
import { ACCOUNT_TEST_JOB, PAYMENTS_QUEUE, type AccountTestJobData } from './payments.constants.js';
import { PAYMENT_PROVIDER } from './provider.js';
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
 * only: a gateway's answer, a URL or a credential never reaches a log line or a failed job.
 */
@Processor(PAYMENTS_QUEUE)
export class PaymentsProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentsProcessor.name);

  constructor(private readonly accounts: GatewayAccountService) {
    super();
  }

  async process(job: Job): Promise<void> {
    try {
      if (job.name === ACCOUNT_TEST_JOB)
        await this.accounts.runTest(job.data as AccountTestJobData);
    } catch (error) {
      this.logger.error(`Payments job ${job.name} failed: ${(error as Error).name}`);
    }
  }
}

@Module({
  imports: [BullModule.registerQueue({ name: PAYMENTS_QUEUE })],
  controllers: [GatewayAccountController],
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
    PaymentsProcessor,
  ],
  exports: [PaymentCredentialsService, PAYMENT_PROVIDER, PAYMENTS_CONFIG],
})
export class PaymentsModule {}

import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { smsLength } from '@jantrik/shared';
import type { Job, Queue } from 'bullmq';
import { RequestContext } from '../common/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantJobRunner } from '../tenancy/tenant-job-runner.service.js';
import { SMS_PROVIDER, type SmsProvider } from './sms.providers.js';
import { TenantSmsService, type TenantSmsJob } from './tenant-sms.service.js';

export const SMS_QUEUE = 'sms';

/** Platform SMS (before any tenant is known): login OTP. */
interface PlatformSmsJob {
  to: string;
  text: string;
}

export type SmsJob = PlatformSmsJob | TenantSmsJob;

const isTenantJob = (job: Job<SmsJob>): job is Job<TenantSmsJob> => job.name === 'tenant';

/** Retries for every SMS job (exponential from 2 s). */
export const SMS_ATTEMPTS = 3;

/**
 * Queues platform SMS (CLAUDE.md rule 5: slow work goes to the queue). Called during a request,
 * the job is enqueued only after the request transaction commits, and dropped if it rolls back.
 * Tenant SMS (logged and billed per tenant) go through TenantSmsService instead.
 */
@Injectable()
export class SmsService {
  constructor(
    @InjectQueue(SMS_QUEUE) private readonly queue: Queue<SmsJob>,
    private readonly context: RequestContext,
  ) {}

  async send(to: string, text: string): Promise<void> {
    await this.context.afterCommit(() =>
      this.queue.add(
        'send',
        { to, text },
        {
          attempts: SMS_ATTEMPTS,
          backoff: { type: 'exponential', delay: 2_000 },
          // Messages can contain OTPs: never keep them in Redis after processing.
          removeOnComplete: true,
          removeOnFail: true,
        },
      ),
    );
  }
}

@Processor(SMS_QUEUE)
export class SmsProcessor extends WorkerHost {
  private readonly logger = new Logger(SmsProcessor.name);

  constructor(
    @Inject(SMS_PROVIDER) private readonly provider: SmsProvider,
    private readonly prisma: PrismaService,
    private readonly runner: TenantJobRunner,
    private readonly tenantSms: TenantSmsService,
  ) {
    super();
  }

  async process(job: Job<SmsJob>): Promise<void> {
    if (isTenantJob(job)) return this.processTenant(job);
    return this.processPlatform(job as Job<PlatformSmsJob>);
  }

  private async processPlatform(job: Job<PlatformSmsJob>): Promise<void> {
    const { to, text } = job.data;
    const segments = smsLength(text).segments;
    try {
      await this.provider.send(to, text);
      await this.logPlatform(to, 'SENT', segments, null);
    } catch (error) {
      // Never log job.data: it may contain an OTP.
      this.logger.error(`SMS job ${job.id} failed: ${(error as Error).message}`);
      if (isLastAttempt(job))
        await this.logPlatform(to, 'FAILED', segments, (error as Error).message);
      throw error;
    }
  }

  /**
   * One row per send attempt outcome, for cost tracking. The body is never stored (OTP).
   * createMany = plain INSERT: the app role may insert into platform_sms_logs but not read it.
   */
  private async logPlatform(
    phone: string,
    status: 'SENT' | 'FAILED',
    segments: number,
    error: string | null,
  ): Promise<void> {
    try {
      await this.prisma.client.platformSmsLog.createMany({
        data: [{ phone, purpose: 'OTP', status, segments, error: error?.slice(0, 500) ?? null }],
      });
    } catch (e) {
      // A logging failure must not turn a delivered OTP into a retry (a second SMS).
      this.logger.error(`platform_sms_logs insert failed: ${(e as Error).message}`);
    }
  }

  private async processTenant(job: Job<TenantSmsJob>): Promise<void> {
    const { tenantId, smsLogId } = job.data;
    // 1. In the tenant's context: load the log row and decide whether it should still go out.
    const toSend = await this.runner.run(tenantId, () => this.tenantSms.prepare(smsLogId));
    if (!toSend) return;
    // 2. Send outside any transaction (no DB connection held during the network call).
    try {
      await this.provider.send(toSend.phone, toSend.body);
    } catch (error) {
      this.logger.error(`tenant SMS ${smsLogId} failed: ${(error as Error).message}`);
      if (isLastAttempt(job)) {
        await this.runner.run(tenantId, () =>
          this.tenantSms.markFailed(smsLogId, (error as Error).message),
        );
      }
      throw error;
    }
    // 3. Record the result.
    await this.runner.run(tenantId, () => this.tenantSms.markSent(smsLogId));
  }
}

const isLastAttempt = (job: Job): boolean => job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

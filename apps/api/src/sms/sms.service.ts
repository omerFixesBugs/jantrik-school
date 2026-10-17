import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { RequestContext } from '../common/request-context.js';
import { SMS_PROVIDER, type SmsProvider } from './sms.providers.js';

export const SMS_QUEUE = 'sms';

interface SmsJob {
  to: string;
  text: string;
}

/**
 * Queues SMS (CLAUDE.md rule 5: slow work goes to the queue). Called during a request, the job
 * is enqueued only after the request transaction commits, and dropped if it rolls back.
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
          attempts: 3,
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

  constructor(@Inject(SMS_PROVIDER) private readonly provider: SmsProvider) {
    super();
  }

  async process(job: Job<SmsJob>): Promise<void> {
    try {
      await this.provider.send(job.data.to, job.data.text);
    } catch (error) {
      // Never log job.data: it may contain an OTP.
      this.logger.error(`SMS job ${job.id} failed: ${(error as Error).message}`);
      throw error;
    }
  }
}

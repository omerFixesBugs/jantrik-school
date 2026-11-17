import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { DelayedError, type Job } from 'bullmq';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';
import { TenantJobRunner } from '../tenancy/tenant-job-runner.service.js';
import {
  BROADCAST_SEND_JOB,
  BroadcastsService,
  NOTICES_QUEUE,
  NOTICES_SWEEP_JOB,
  type BroadcastJobData,
  type SendOutcome,
} from './broadcasts.service.js';

/**
 * The `notices` queue: `broadcast-send` (one broadcast, delayed to its time; job id
 * `broadcast-<id>`) and `notices-sweep` (every 5 minutes, re-adds jobs Redis lost from the
 * `notices:due` set). Job data holds ids only; no SQL runs outside an institute's context.
 */
@Processor(NOTICES_QUEUE)
export class NoticesProcessor extends WorkerHost {
  private readonly logger = new Logger(NoticesProcessor.name);

  constructor(
    private readonly jobs: TenantJobRunner,
    private readonly broadcasts: BroadcastsService,
    private readonly access: TenantAccessService,
  ) {
    super();
  }

  async process(job: Job, token?: string): Promise<void> {
    if (job.name === NOTICES_SWEEP_JOB) await this.broadcasts.sweep();
    if (job.name !== BROADCAST_SEND_JOB) return;
    const outcome = await this.send(job.data as BroadcastJobData);
    // Not yet (quiet hours, or an early run): this same job waits for the new time.
    if (outcome.kind === 'LATER' && token) {
      await job.moveToDelayed(outcome.at.getTime(), token);
      throw new DelayedError();
    }
  }

  /** Safe to run twice: the second run finds the broadcast no longer SCHEDULED and stops. */
  async send({ tenantId, broadcastId }: BroadcastJobData): Promise<SendOutcome> {
    const head = await this.jobs.run(tenantId, () => this.broadcasts.scheduledBy(broadcastId));
    if (!head || head.status !== 'SCHEDULED' || !head.scheduledById) {
      await this.broadcasts.forget(tenantId, broadcastId);
      return { kind: 'STOP' };
    }
    const roles = await this.access.getRoles(tenantId, head.scheduledById);
    const stillAdmin = roles.includes('OWNER') || roles.includes('ADMIN');
    const outcome = await this.jobs.run(
      tenantId,
      () => this.broadcasts.sendDue(broadcastId, stillAdmin),
      { actorUserId: head.scheduledById },
    );
    if (outcome.kind === 'LATER') {
      // The due set moves to the new time; the job itself is delayed by process().
      await this.broadcasts.markDue(tenantId, broadcastId, outcome.at);
    } else {
      await this.broadcasts.forget(tenantId, broadcastId);
    }
    if (outcome.kind !== 'SENT' && outcome.kind !== 'LATER') {
      this.logger.warn(`Broadcast ${broadcastId}: ${outcome.kind}`);
    }
    return outcome;
  }
}

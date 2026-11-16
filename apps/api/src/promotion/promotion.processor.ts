import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';
import { TenantJobRunner } from '../tenancy/tenant-job-runner.service.js';
import {
  applyErrorCode,
  LEAVERS_PER_CHUNK,
  PERMANENT_ERRORS,
  PROMOTION_APPLY_JOB,
  PROMOTIONS_QUEUE,
  PromotionApplyService,
  type PromotionApplyJobData,
} from './promotion-apply.service.js';

/**
 * Applies a promotion run (job `promotion-apply`, one per run): each target section in its own
 * transaction, then the leavers in chunks, then the run is APPLIED, all acting as the admin who
 * pressed apply. A section that cannot be done stops the job with `last_error` (the run stays
 * APPLYING): a full section or a deactivated target is permanent (the admin fixes it and
 * resumes), anything else is retried by BullMQ with backoff. Every step skips rows already
 * applied, so a retry, a resume or a second execution continues where the first stopped.
 */
@Processor(PROMOTIONS_QUEUE)
export class PromotionProcessor extends WorkerHost {
  private readonly logger = new Logger(PromotionProcessor.name);

  constructor(
    private readonly jobs: TenantJobRunner,
    private readonly apply: PromotionApplyService,
    private readonly access: TenantAccessService,
  ) {
    super();
  }

  async process(job: Job<PromotionApplyJobData>): Promise<void> {
    if (job.name !== PROMOTION_APPLY_JOB) return;
    await this.run(job.data);
  }

  /** The whole apply of one run (also called directly by tests). */
  async run(data: PromotionApplyJobData): Promise<void> {
    const { tenantId, runId, actorUserId } = data;
    const roles = await this.access.getRoles(tenantId, actorUserId);
    if (!roles.includes('OWNER') && !roles.includes('ADMIN')) {
      await this.jobs.run(tenantId, () => this.apply.markError(runId, 'ACTOR_NOT_ADMIN'));
      throw new UnrecoverableError('ACTOR_NOT_ADMIN');
    }
    const opts = { actorUserId };
    try {
      const { applying, sections } = await this.jobs.run(
        tenantId,
        () => this.apply.pendingSections(runId),
        opts,
      );
      if (!applying) return;
      for (const sectionId of sections) {
        await this.jobs.run(tenantId, () => this.apply.applySection(runId, sectionId), opts);
      }
      while (
        (await this.jobs.run(
          tenantId,
          () => this.apply.applyLeavers(runId, LEAVERS_PER_CHUNK),
          opts,
        )) > 0
      );
      const done = await this.jobs.run(tenantId, () => this.apply.finish(runId), opts);
      // Rows still pending after every step (e.g. one added meanwhile): try again.
      if (!done) throw new Error('INCOMPLETE');
    } catch (error) {
      const code = applyErrorCode(error);
      // Not the message: database errors can contain row values (personal data).
      this.logger.error(`Promotion run ${runId} stopped: ${code} (${(error as Error).name})`);
      await this.jobs.run(tenantId, () => this.apply.markError(runId, code), opts);
      if (PERMANENT_ERRORS.has(code)) throw new UnrecoverableError(code);
      throw error;
    }
  }
}

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { TenantJobRunner } from '../tenancy/tenant-job-runner.service.js';
import {
  ADMISSION_QUEUE,
  AdmissionApprovalService,
  BULK_APPROVE_JOB,
  approvalProblem,
  stopsBulk,
  type BulkApproveJob,
} from './approval.service.js';

/**
 * Bulk approval (decision P3-T): one application per transaction, acting as the admin who
 * started it (their role is checked again for each). A row that needs a guardian choice, or is a
 * duplicate, is skipped with its problem recorded; the student limit, a full section or a
 * deactivated class or section stops the run and marks the rest with that problem. A re-run picks
 * up what is left.
 */
@Processor(ADMISSION_QUEUE)
export class AdmissionApprovalProcessor extends WorkerHost {
  private readonly logger = new Logger(AdmissionApprovalProcessor.name);

  constructor(
    private readonly jobs: TenantJobRunner,
    private readonly approval: AdmissionApprovalService,
  ) {
    super();
  }

  async process(job: Job<BulkApproveJob>): Promise<void> {
    if (job.name !== BULK_APPROVE_JOB) return;
    const { tenantId, cycleClassId, sectionId, actorUserId } = job.data;
    const actor = { actorUserId };
    const ids = await this.jobs.run(
      tenantId,
      () => this.approval.bulkCandidates(cycleClassId, actorUserId),
      actor,
    );
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      try {
        const go = await this.jobs.run(
          tenantId,
          () => this.approval.approveInBulk(id, sectionId, actorUserId),
          actor,
        );
        if (!go) return;
      } catch (error) {
        const problem = approvalProblem(error);
        if (problem === 'INVALID') {
          // Not the message: database errors can contain row values (personal data).
          this.logger.error(`Bulk approval of ${id} failed: ${(error as Error).name}`);
        }
        const marked = stopsBulk(problem) ? ids.slice(i) : [id];
        await this.jobs.run(tenantId, () => this.approval.markProblem(marked, problem), actor);
        if (stopsBulk(problem)) return;
      }
    }
  }
}

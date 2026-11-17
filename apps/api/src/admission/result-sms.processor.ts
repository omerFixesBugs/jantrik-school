import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';
import { TenantJobRunner } from '../tenancy/tenant-job-runner.service.js';
import {
  ADMISSION_RESULTS_QUEUE,
  AdmissionResultSmsService,
  SEND_ADMISSION_RESULT_SMS_JOB,
  type AdmissionResultSmsJobData,
} from './result-sms.service.js';

const CHUNK = 25;

/** A confirmed admission result SMS run: 25 per transaction, acting as the admin who sent it. */
@Processor(ADMISSION_RESULTS_QUEUE)
export class AdmissionResultSmsProcessor extends WorkerHost {
  private readonly logger = new Logger(AdmissionResultSmsProcessor.name);

  constructor(
    private readonly jobs: TenantJobRunner,
    private readonly access: TenantAccessService,
    private readonly sms: AdmissionResultSmsService,
  ) {
    super();
  }

  async process(job: Job<AdmissionResultSmsJobData>): Promise<void> {
    if (job.name !== SEND_ADMISSION_RESULT_SMS_JOB) return;
    const data = job.data;
    try {
      // Their request was checked; this is later: are they still OWNER/ADMIN?
      const roles = await this.access.getRoles(data.tenantId, data.actorUserId);
      if (!roles.includes('OWNER') && !roles.includes('ADMIN')) return;
      const opts = { actorUserId: data.actorUserId };
      const all = await this.jobs.run(
        data.tenantId,
        () => this.sms.runRecipients(data.runId),
        opts,
      );
      for (let i = 0; i < all.length; i += CHUNK) {
        const chunk = all.slice(i, i + CHUNK);
        await this.jobs.run(data.tenantId, () => this.sms.sendChunk(data, chunk), opts);
      }
    } catch (error) {
      // The name only: a database error can carry row values (personal data).
      this.logger.error(
        `Admission result SMS failed for ${data.tenantId}: ${(error as Error).name}`,
      );
    }
  }
}

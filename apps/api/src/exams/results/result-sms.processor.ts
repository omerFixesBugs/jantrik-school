import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { TenantAccessService } from '../../tenancy/tenant-access.service.js';
import { TenantJobRunner } from '../../tenancy/tenant-job-runner.service.js';
import {
  EXAMS_QUEUE,
  ResultSmsService,
  SEND_RESULT_SMS_JOB,
  type ResultSmsJobData,
} from './result-sms.service.js';

const CHUNK = 25;

/** A confirmed result SMS run: 25 students per transaction, acting as the admin who sent it. */
@Processor(EXAMS_QUEUE)
export class ResultSmsProcessor extends WorkerHost {
  private readonly logger = new Logger(ResultSmsProcessor.name);

  constructor(
    private readonly jobs: TenantJobRunner,
    private readonly access: TenantAccessService,
    private readonly sms: ResultSmsService,
  ) {
    super();
  }

  async process(job: Job<ResultSmsJobData>): Promise<void> {
    if (job.name !== SEND_RESULT_SMS_JOB) return;
    const data = job.data;
    try {
      // Their request was checked; this is later: are they still OWNER/ADMIN?
      const roles = await this.access.getRoles(data.tenantId, data.actorUserId);
      if (!roles.includes('OWNER') && !roles.includes('ADMIN')) return;
      const opts = { actorUserId: data.actorUserId };
      const ids = await this.jobs.run(data.tenantId, () => this.sms.runStudents(data.runId), opts);
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        await this.jobs.run(data.tenantId, () => this.sms.sendChunk(data, chunk), opts);
      }
    } catch (error) {
      this.logger.error(`Result SMS failed for ${data.tenantId}: ${(error as Error).name}`);
    }
  }
}

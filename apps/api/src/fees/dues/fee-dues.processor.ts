import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS } from '../../redis/redis.constants.js';
import { TenantAccessService } from '../../tenancy/tenant-access.service.js';
import { TenantJobRunner } from '../../tenancy/tenant-job-runner.service.js';
import {
  FEES_QUEUE,
  FEES_TENANTS_KEY,
  FeeDuesService,
  GENERATE_DUES_JOB,
} from './fee-dues.service.js';

const CHUNK = 500;

/**
 * The nightly dues run (00:30 Asia/Dhaka). It never queries across institutes: it visits the
 * institutes listed in Redis (`fees:tenants`, refreshed whenever fees are used), each in its own
 * RLS transactions with no person acting (audit rows have no actor). One failing institute does
 * not stop the others. Correctness does not depend on it: views and reports generate dues too.
 */
@Processor(FEES_QUEUE)
export class FeeDuesProcessor extends WorkerHost {
  private readonly logger = new Logger(FeeDuesProcessor.name);

  constructor(
    private readonly jobs: TenantJobRunner,
    private readonly dues: FeeDuesService,
    private readonly access: TenantAccessService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === GENERATE_DUES_JOB) await this.generateAll();
  }

  async generateAll(): Promise<void> {
    for (const tenantId of await this.redis.zrange(FEES_TENANTS_KEY, 0, -1)) {
      try {
        if (!(await this.access.getEnabledModules(tenantId)).includes('FEES')) continue;
        const ids = await this.jobs.run(tenantId, async () =>
          (await this.dues.tenantIsLive()) ? this.dues.activeStudentIds() : [],
        );
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunk = ids.slice(i, i + CHUNK);
          await this.jobs.run(tenantId, () =>
            this.dues.ensureForStudents(chunk, { trigger: 'nightly' }),
          );
        }
      } catch (error) {
        // Not the message: database errors can contain row values.
        this.logger.error(`Dues run failed for ${tenantId}: ${(error as Error).name}`);
      }
    }
  }
}

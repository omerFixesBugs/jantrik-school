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
  GENERATE_TENANT_JOB,
  RECALCULATE_TENANT_JOB,
  type TenantJobData,
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
    if (job.name === GENERATE_TENANT_JOB) await this.generateTenant(job.data as TenantJobData);
    if (job.name === RECALCULATE_TENANT_JOB)
      await this.recalculateTenant(job.data as TenantJobData);
  }

  /** Is the admin who asked still OWNER/ADMIN? (Their request was checked; this is later.) */
  private async actorMayStill(data: TenantJobData): Promise<boolean> {
    if (!data.actorUserId) return true;
    const roles = await this.access.getRoles(data.tenantId, data.actorUserId);
    return roles.includes('OWNER') || roles.includes('ADMIN');
  }

  /** One institute's dues, 500 students per transaction (admin "generate now", before reports). */
  async generateTenant(data: TenantJobData): Promise<void> {
    try {
      if (!(await this.actorMayStill(data))) return;
      const opts = data.actorUserId ? { actorUserId: data.actorUserId } : {};
      const ids = await this.jobs.run(data.tenantId, () => this.dues.activeStudentIds(), opts);
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        await this.jobs.run(
          data.tenantId,
          () =>
            this.dues.ensureForStudents(chunk, { trigger: data.actorUserId ? 'admin' : 'daily' }),
          opts,
        );
      }
    } catch (error) {
      this.logger.error(`Dues generation failed for ${data.tenantId}: ${(error as Error).name}`);
    }
  }

  /** One institute's untouched dues rewritten from today's setup, 200 students per transaction. */
  async recalculateTenant(data: TenantJobData): Promise<void> {
    try {
      if (!(await this.actorMayStill(data))) return;
      const opts = data.actorUserId ? { actorUserId: data.actorUserId } : {};
      const ids = await this.jobs.run(
        data.tenantId,
        () => this.dues.studentsWithUntouchedDues(),
        opts,
      );
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        await this.jobs.run(data.tenantId, () => this.dues.recalculateUnpaid(chunk), opts);
      }
    } catch (error) {
      this.logger.error(`Dues recalculation failed for ${data.tenantId}: ${(error as Error).name}`);
    }
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

import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.constants.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';
import { TenantJobRunner } from '../tenancy/tenant-job-runner.service.js';
import { DeviceRegistersService } from './device-registers.service.js';
import {
  DEVICES_QUEUE,
  DEVICES_TENANTS_KEY,
  DEVICES_TICK_JOB,
  PROCESS_PUNCHES_JOB,
  type ProcessPunchesJob,
} from './devices.constants.js';
import { PunchProcessingService } from './punch-processing.service.js';

/**
 * Punches per transaction, so each stays well inside the job transaction's 15 s limit (and near
 * the 5 s a punch review waits for the punch lock). The slowest kind, a student's entry SMS plus
 * a change on a DEVICE register, takes about 45 ms a punch on a development machine: 500 of them
 * passed 15 s, 100 take about 5 s.
 */
export const PUNCH_BATCH = 100;

/**
 * The devices worker. `process-punches` (queued by the receiver after it stored punches) processes
 * one institute's new punches. While that job is waiting, running or kept as failed, the receiver
 * cannot queue another for the institute, so `devices-tick` visits every minute the institutes in
 * `devices:tenants` (with ATTENDANCE on) for leftovers, then writes the registers due at a shift's
 * cutoff (`DeviceRegistersService.cutoff`). Each institute is processed in its own RLS
 * transactions with no person acting; no query crosses institutes.
 */
@Processor(DEVICES_QUEUE)
export class DevicesProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(DevicesProcessor.name);

  constructor(
    @InjectQueue(DEVICES_QUEUE) private readonly queue: Queue,
    private readonly runner: TenantJobRunner,
    private readonly access: TenantAccessService,
    private readonly processing: PunchProcessingService,
    private readonly registers: DeviceRegistersService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    super();
  }

  /** One scheduler for all API instances (BullMQ upserts it by id). */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      DEVICES_TICK_JOB,
      { pattern: '* * * * *', tz: 'Asia/Dhaka' },
      { name: DEVICES_TICK_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } },
    );
  }

  async process(job: Job): Promise<void> {
    if (job.name === PROCESS_PUNCHES_JOB) {
      const { tenantId } = job.data as ProcessPunchesJob;
      try {
        await this.drain(tenantId);
      } catch (error) {
        // Not the message: database errors can contain row values. The tick retries.
        this.logger.error(`Punch processing failed for ${tenantId}: ${(error as Error).name}`);
      }
    }
    if (job.name === DEVICES_TICK_JOB) await this.tickAll();
  }

  /** Every institute listed for devices, one after the other; one failing stops none of the rest. */
  async tickAll(): Promise<void> {
    for (const tenantId of await this.redis.zrange(DEVICES_TENANTS_KEY, 0, -1)) {
      try {
        if (!(await this.access.getEnabledModules(tenantId)).includes('ATTENDANCE')) continue;
        await this.tick(tenantId);
      } catch (error) {
        this.logger.error(`Devices tick failed for ${tenantId}: ${(error as Error).name}`);
      }
    }
  }

  /** One institute's minute: its leftover punches first, then the registers due at a cutoff. */
  async tick(tenantId: string): Promise<void> {
    await this.drain(tenantId);
    await this.runner.run(tenantId, () => this.registers.cutoff());
  }

  /** All of the institute's unprocessed punches, `PUNCH_BATCH` per transaction. */
  async drain(tenantId: string): Promise<void> {
    let processed: number;
    do {
      processed = await this.runner.run(tenantId, () => this.processing.processBatch(PUNCH_BATCH));
    } while (processed >= PUNCH_BATCH);
  }
}

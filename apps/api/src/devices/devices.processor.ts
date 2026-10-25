import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.constants.js';
import { TenantAccessService } from '../tenancy/tenant-access.service.js';
import { TenantJobRunner } from '../tenancy/tenant-job-runner.service.js';
import { DeviceRegistersService } from './device-registers.service.js';
import { DeviceRetentionService } from './device-retention.service.js';
import {
  DEVICES_QUEUE,
  DEVICES_TENANTS_KEY,
  DEVICES_TICK_JOB,
  EXPIRE_PUNCHES_JOB,
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

/** Rows the retention job deletes per transaction. */
export const RETENTION_CHUNK = 5000;

/**
 * The devices worker. `process-punches` (queued by the receiver after it stored punches) processes
 * one institute's new punches. While that job is waiting, running or kept as failed, the receiver
 * cannot queue another for the institute, so `devices-tick` visits every minute the institutes in
 * `devices:tenants` (with ATTENDANCE on) for leftovers, then writes the registers due at a shift's
 * cutoff (`cutoff`, one section per transaction). `expire-punches` deletes, daily, what is past
 * retention for every institute in `devices:tenants` (`DeviceRetentionService`). Each institute is
 * processed in its own RLS transactions with no person acting; no query crosses institutes.
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
    private readonly retention: DeviceRetentionService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    super();
  }

  /** One scheduler of each for all API instances (BullMQ upserts them by id). */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      DEVICES_TICK_JOB,
      { pattern: '* * * * *', tz: 'Asia/Dhaka' },
      { name: DEVICES_TICK_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } },
    );
    await this.queue.upsertJobScheduler(
      EXPIRE_PUNCHES_JOB,
      { pattern: '40 0 * * *', tz: 'Asia/Dhaka' },
      { name: EXPIRE_PUNCHES_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } },
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
    if (job.name === EXPIRE_PUNCHES_JOB) await this.expireAll();
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
    await this.cutoff(tenantId);
  }

  /**
   * The registers due at a shift's cutoff, one section per transaction, so a big section never
   * holds up the others; one failing (logged by the error name) stops none of the rest and is
   * tried again the next minute.
   */
  async cutoff(tenantId: string): Promise<void> {
    const due = await this.runner.run(tenantId, () => this.registers.dueSections());
    for (const sectionId of due) {
      try {
        await this.runner.run(tenantId, () => this.registers.closeAtCutoff(sectionId));
      } catch (error) {
        // Not the message: database errors can contain row values.
        this.logger.error(
          `Cutoff failed for ${tenantId}, section ${sectionId}: ${(error as Error).name}`,
        );
      }
    }
  }

  /** All of the institute's unprocessed punches, `PUNCH_BATCH` per transaction. */
  async drain(tenantId: string): Promise<void> {
    let processed: number;
    do {
      processed = await this.runner.run(tenantId, () => this.processing.processBatch(PUNCH_BATCH));
    } while (processed >= PUNCH_BATCH);
  }

  /**
   * Retention for every institute listed for devices, ATTENDANCE on or not (data minimisation).
   * One failing stops none of the rest; it stays listed and is visited again the next day.
   */
  async expireAll(): Promise<void> {
    for (const tenantId of await this.redis.zrange(DEVICES_TENANTS_KEY, 0, -1)) {
      try {
        await this.expire(tenantId);
      } catch (error) {
        // Not the message: database errors can contain row values.
        this.logger.error(`Device retention failed for ${tenantId}: ${(error as Error).name}`);
      }
    }
  }

  /**
   * One institute's old punches, then its old commands, `RETENTION_CHUNK` per transaction. What
   * was deleted is logged as counts only.
   */
  async expire(tenantId: string): Promise<void> {
    const punches = await this.inChunks(tenantId, () =>
      this.retention.deletePunches(RETENTION_CHUNK),
    );
    const commands = await this.inChunks(tenantId, () =>
      this.retention.deleteCommands(RETENTION_CHUNK),
    );
    if (punches + commands > 0) {
      this.logger.log(
        `Retention deleted ${punches} punches and ${commands} device commands of tenant ${tenantId}`,
      );
    }
  }

  /** `chunk` in its own transaction, again while it deletes `RETENTION_CHUNK`; the total. */
  private async inChunks(tenantId: string, chunk: () => Promise<number>): Promise<number> {
    let total = 0;
    let deleted: number;
    do {
      deleted = await this.runner.run(tenantId, chunk);
      total += deleted;
    } while (deleted >= RETENTION_CHUNK);
    return total;
  }
}

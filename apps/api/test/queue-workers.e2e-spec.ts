import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';

// Who processes the queues' jobs: the API by default (as before), or a separate worker process
// (worker-main.ts) while the API runs with QUEUE_WORKERS=false. Modules are imported afresh after
// the environment changes, as `node dist/…` would read it.

describe('queue workers', () => {
  const saved = { ...process.env };
  let prefix: string;

  beforeEach(() => {
    // Queues and schedules under a prefix of its own, so no other test's jobs are taken.
    prefix = `jantrik-test-workers-${randomUUID().slice(0, 8)}`;
  });

  afterEach(async () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    const redis = new Redis(saved['REDIS_URL']!);
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  /** The modules as a fresh process would load them, with `env` set. */
  const load = async (env: Record<string, string>) => {
    Object.assign(process.env, { QUEUE_PREFIX: prefix, ...env });
    vi.resetModules();
    const { SmsProcessor } = await import('../src/sms/sms.service.js');
    const { DevicesProcessor } = await import('../src/devices/devices.processor.js');
    const constants = await import('../src/devices/devices.constants.js');
    return { SmsProcessor, DevicesProcessor, constants };
  };

  /** No device tick or retention in tests (see harness.ts). */
  const stopSchedules = async (
    app: INestApplicationContext,
    c: Awaited<ReturnType<typeof load>>['constants'],
  ) => {
    const devices = app.get<Queue>(getQueueToken(c.DEVICES_QUEUE));
    await devices.removeJobScheduler(c.DEVICES_TICK_JOB);
    await devices.removeJobScheduler(c.EXPIRE_PUNCHES_JOB);
  };

  it('the worker process runs every processor and serves no HTTP', async () => {
    const { SmsProcessor, DevicesProcessor, constants } = await load({ QUEUE_WORKERS: 'true' });
    const { startWorker } = await import('../src/worker.bootstrap.js');
    const app = await startWorker();
    try {
      await stopSchedules(app, constants);
      expect(app.get(SmsProcessor).worker.isRunning()).toBe(true);
      expect(app.get(DevicesProcessor).worker.isRunning()).toBe(true);
      expect('getHttpServer' in app).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('the worker refuses QUEUE_WORKERS=false (it would process nothing)', async () => {
    await load({ QUEUE_WORKERS: 'false' });
    const { startWorker } = await import('../src/worker.bootstrap.js');
    await expect(startWorker()).rejects.toThrow(/QUEUE_WORKERS=false/);
  });

  it('an API with QUEUE_WORKERS=false starts no worker, and still queues jobs', async () => {
    const { SmsProcessor, DevicesProcessor, constants } = await load({ QUEUE_WORKERS: 'false' });
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      await stopSchedules(app, constants);
      expect(() => app.get(SmsProcessor).worker).toThrow(/not yet been initialized/);
      expect(() => app.get(DevicesProcessor).worker).toThrow(/not yet been initialized/);
      const { SMS_QUEUE } = await import('../src/sms/sms.service.js');
      const sms = app.get<Queue>(getQueueToken(SMS_QUEUE));
      const job = await sms.add('noop', { to: '+8801700000000', text: 'x' });
      expect(await job.getState()).toBe('waiting');
      await job.remove();
    } finally {
      await app.close();
    }
  });
});

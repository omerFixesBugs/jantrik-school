import { Logger, type INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

/**
 * The queue worker (worker-main.ts): the API's modules without HTTP (no port, no routes), so only
 * the queue processors and their schedules run. Same environment as the API; the API next to it
 * runs with QUEUE_WORKERS=false (docs/deploy.md).
 */
export async function startWorker(): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  if (!app.get<ConfigService<Env, true>>(ConfigService).get('QUEUE_WORKERS', { infer: true })) {
    // Copied from the API's settings by mistake: a worker that processes nothing must not look up.
    await app.close();
    throw new Error('QUEUE_WORKERS=false: the worker would process no jobs. Remove it here.');
  }
  new Logger('QueueWorker').log('queue worker started');
  return app;
}

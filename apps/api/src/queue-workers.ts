import { BullRegistrar } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './config/env.js';

/**
 * Starts the BullMQ workers (every `@Processor` class: SMS, imports, fees, exams, devices) unless
 * `QUEUE_WORKERS=false`. AppModule asks BullModule not to start them by itself
 * (`manualRegistration`), so an API can run without processing jobs while a separate worker
 * process (`worker-main.ts`) does. Default: on, so the API keeps processing its jobs as before.
 */
@Injectable()
export class QueueWorkers implements OnApplicationBootstrap {
  constructor(
    private readonly registrar: BullRegistrar,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** After every module's init, so a processor never runs before its module is ready. */
  onApplicationBootstrap(): void {
    if (this.config.get('QUEUE_WORKERS', { infer: true })) this.registrar.register();
  }
}

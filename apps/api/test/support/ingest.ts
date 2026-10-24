import type { AddressInfo } from 'node:net';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createPrismaClient, type PrismaClient } from '@jantrik/db';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { Clock } from '../../src/common/clock.js';
import { validateEnv, type Env } from '../../src/config/env.js';
import { DEVICES_QUEUE } from '../../src/devices/devices.constants.js';
import { configureIngestApp } from '../../src/ingest/ingest.bootstrap.js';
import { IngestPrismaService } from '../../src/ingest/ingest-prisma.service.js';
import { IngestAppModule } from '../../src/ingest/ingest.module.js';
import { REDIS } from '../../src/redis/redis.constants.js';

export interface IngestHarness {
  app: NestExpressApplication;
  /** The receiver's address, for `@jantrik/device-sim` and fetch. */
  baseUrl: string;
  /** Fixture client (app role, RLS applies): institutes, devices, commands. */
  prisma: PrismaClient;
  /** The receiver's own client (jantrik_ingest_app), to spy on its calls. */
  ingestDb: PrismaClient;
  redis: Redis;
  queue: Queue;
  close(): Promise<void>;
}

/**
 * Boots the device receiver (IngestAppModule) on an ephemeral port, on every interface like the
 * real one, so an IPv4 client shows up as `::ffff:127.0.0.1`. `clock` replaces the Clock (a
 * FakeClock); `env` overrides environment variables, e.g. lower limits.
 */
export async function createIngestHarness(
  opts: { clock?: Clock; env?: Record<string, string> } = {},
): Promise<IngestHarness> {
  const builder = Test.createTestingModule({ imports: [IngestAppModule] });
  if (opts.clock) builder.overrideProvider(Clock).useValue(opts.clock);
  if (opts.env) {
    const env = validateEnv({ ...process.env, ...opts.env });
    builder.overrideProvider(ConfigService).useValue({ get: (key: keyof Env) => env[key] });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureIngestApp(app);
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;
  const prisma = createPrismaClient(process.env['DATABASE_URL']!);
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    prisma,
    ingestDb: app.get(IngestPrismaService).client,
    redis: app.get<Redis>(REDIS),
    queue: app.get<Queue>(getQueueToken(DEVICES_QUEUE)),
    async close() {
      await app.close();
      await prisma.$disconnect();
    },
  };
}

export const ingestHttp = (h: IngestHarness) => request(h.baseUrl);

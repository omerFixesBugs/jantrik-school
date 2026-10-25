import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createPrismaClient, withTenant } from '@jantrik/db';
import { envSchema } from '../src/config/env.js';
import { ingestEnvSchema } from '../src/config/ingest-env.js';
import { createTenant } from './support/harness.js';

// The stand-alone device receiver starts from its own variables (src/config/ingest-env.ts): in
// production it is given none of the API's logins or secrets. The module is imported afresh
// after the environment is cut down, as `node dist/ingest-main.js` would read it.

const newSerial = () => `T${randomUUID().replace(/-/g, '').slice(0, 15).toUpperCase()}`;

const apiOnly = Object.keys(envSchema.in.shape).filter((k) => !(k in ingestEnvSchema.shape));

describe('device receiver environment', () => {
  const saved = { ...process.env };
  const cwd = process.cwd();
  let dir: string;

  /**
   * Only the receiver's variables in the environment, and no `../../.env` to read: a working
   * directory two levels into an empty temporary one.
   */
  const receiverOnly = (env: Record<string, string>) => {
    for (const key of Object.keys(process.env)) {
      if (apiOnly.includes(key) || /^(DATABASE_|DB_|POSTGRES_)/.test(key)) delete process.env[key];
    }
    Object.assign(process.env, env);
    dir = mkdtempSync(path.join(tmpdir(), 'jantrik-ingest-env-'));
    const work = path.join(dir, 'apps', 'api');
    mkdirSync(work, { recursive: true });
    process.chdir(work);
    vi.resetModules();
  };

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it('boots in production with only its own variables and answers a device', async () => {
    // The fixture first, with the test's app login.
    const prisma = createPrismaClient(process.env['DATABASE_URL']!);
    const tenant = await createTenant({ prisma }, { modules: ['ATTENDANCE'] });
    const serialNo = newSerial();
    await withTenant(prisma, tenant.id, (tx) =>
      tx.attendanceDevice.create({
        data: { tenantId: tenant.id, serialNo, name: 'Gate', direction: 'BOTH' },
      }),
    );
    await prisma.$disconnect();

    receiverOnly({
      NODE_ENV: 'production',
      DATABASE_INGEST_URL: saved['DATABASE_INGEST_URL']!,
      REDIS_URL: saved['REDIS_URL']!,
      QUEUE_PREFIX: saved['QUEUE_PREFIX']!,
    });
    for (const key of [
      'DATABASE_URL',
      'DATABASE_PLATFORM_URL',
      'JWT_ACCESS_SECRET',
      'OTP_PEPPER',
    ]) {
      expect(process.env[key]).toBeUndefined();
    }
    const { IngestAppModule } = await import('../src/ingest/ingest.module.js');
    const { configureIngestApp } = await import('../src/ingest/ingest.bootstrap.js');
    const moduleRef = await Test.createTestingModule({ imports: [IngestAppModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureIngestApp(app);
    try {
      await app.listen(0, '127.0.0.1');
      const { port } = app.getHttpServer().address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/iclock/ping?SN=${serialNo}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('OK');
      const config = app.get(ConfigService);
      expect(config.get('NODE_ENV')).toBe('production');
      expect(config.get('INGEST_PER_IP_PER_MIN')).toBe(1200);
    } finally {
      await app.close();
    }
  });

  it('refuses to start without DATABASE_INGEST_URL', async () => {
    receiverOnly({
      NODE_ENV: 'production',
      REDIS_URL: saved['REDIS_URL']!,
      QUEUE_PREFIX: saved['QUEUE_PREFIX']!,
    });
    const { IngestAppModule } = await import('../src/ingest/ingest.module.js');
    await expect(
      Test.createTestingModule({ imports: [IngestAppModule] }).compile(),
    ).rejects.toThrow(/DATABASE_INGEST_URL/);
  });
});

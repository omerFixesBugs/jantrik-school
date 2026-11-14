import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createPrismaClient, withTenant } from '@jantrik/db';
import { Redis } from 'ioredis';
import { envSchema } from '../src/config/env.js';
import { ingestEnvSchema } from '../src/config/ingest-env.js';
import { createTenant } from './support/harness.js';

// The stand-alone device receiver starts from its own variables (src/config/ingest-env.ts): in
// production it is given none of the API's logins or secrets. And the API with the receiver in its
// own process is given none of the receiver's: it never loads the receiver's code unless it runs
// it (INGEST_IN_PROCESS).
// Modules are imported afresh after the environment is cut down, as `node dist/…` would read it.

const newSerial = () => `T${randomUUID().replace(/-/g, '').slice(0, 15).toUpperCase()}`;

const apiOnly = Object.keys(envSchema.in.shape).filter((k) => !(k in ingestEnvSchema.shape));

/** A port nothing listens on (API_PORT must be a positive number). */
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

describe('device receiver environment', () => {
  const saved = { ...process.env };
  const cwd = process.cwd();
  let dir: string;

  /** No `../../.env` to read: a working directory two levels into an empty temporary one. */
  const emptyWorkDir = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'jantrik-ingest-env-'));
    const work = path.join(dir, 'apps', 'api');
    mkdirSync(work, { recursive: true });
    process.chdir(work);
    vi.resetModules();
  };

  /**
   * Only the receiver's variables in the environment. Devices connect directly (no proxy): the
   * tests' INGEST_TRUST_PROXY=true is refused in production.
   */
  const receiverOnly = (env: Record<string, string>) => {
    for (const key of Object.keys(process.env)) {
      if (apiOnly.includes(key) || /^(DATABASE_|DB_|POSTGRES_)/.test(key)) delete process.env[key];
    }
    Object.assign(process.env, { INGEST_TRUST_PROXY: 'false' }, env);
    emptyWorkDir();
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

  it("ingest-main.ts (the receiver's own process) exits with 1 without DATABASE_INGEST_URL", async () => {
    receiverOnly({
      NODE_ENV: 'production',
      REDIS_URL: saved['REDIS_URL']!,
      QUEUE_PREFIX: saved['QUEUE_PREFIX']!,
    });
    // Nest ends a failed start with process.exit(1) (and process.abort() should that return);
    // here both throw instead.
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const abort = vi.spyOn(process, 'abort').mockImplementation(() => {
      throw new Error('process.abort()');
    });
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(import('../src/ingest-main.js')).rejects.toThrow(/process\.(exit|abort)/);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toContain('DATABASE_INGEST_URL');
    abort.mockRestore();
    exit.mockRestore();
    errors.mockRestore();
  });

  it('the API with the receiver in its own process starts without DATABASE_INGEST_URL and loads no receiver code', async () => {
    const port = await freePort();
    const prefix = `jantrik-test-entry-${randomUUID().slice(0, 8)}`;
    // The documented production API: none of the receiver's login, the receiver in its own
    // process. (NODE_ENV stays test, with the tests' secrets and SMS provider; the production
    // rules have their own tests in src/config/production-env.spec.ts.)
    delete process.env['DATABASE_INGEST_URL'];
    Object.assign(process.env, {
      INGEST_IN_PROCESS: 'false',
      API_PORT: String(port),
      QUEUE_PREFIX: prefix,
      INGEST_PUBLIC_HOST: 'devices.example.com',
    });
    emptyWorkDir();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const { startApi } = await import('../src/api.bootstrap.js');
    const { api, receiver } = await startApi();
    try {
      expect(receiver).toBeNull();
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      // Give a rejected import a moment to surface.
      await new Promise((r) => setTimeout(r, 200));
      expect(unhandled).toEqual([]);
    } finally {
      await api.close();
      process.off('unhandledRejection', onUnhandled);
      // Its queues and schedulers, under a prefix of its own.
      const redis = new Redis(saved['REDIS_URL']!);
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
    }
  });
});

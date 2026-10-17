import { execSync } from 'node:child_process';
import path from 'node:path';
import { Redis } from 'ioredis';
import { E2E_REDIS_URL } from '../playwright.config';

/**
 * Migrate + seed jantrik_e2e (idempotent: demo tenants are created once) and flush the e2e
 * Redis DB, which holds the SMS outbox and rate-limit counters.
 */
export default async function globalSetup(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '../../..');
  const ownerUrl = process.env['DATABASE_MIGRATION_URL_E2E'];
  const appUrl = process.env['DATABASE_URL_E2E'];
  if (!ownerUrl?.includes('/jantrik_e2e') || !appUrl?.includes('/jantrik_e2e')) {
    throw new Error('DATABASE_URL_E2E / DATABASE_MIGRATION_URL_E2E must point at jantrik_e2e');
  }
  if (!/\/([1-9]|1[0-5])$/.test(E2E_REDIS_URL)) {
    throw new Error('REDIS_URL_E2E must select a non-zero Redis database (it is flushed)');
  }

  const env = { ...process.env, DATABASE_MIGRATION_URL: ownerUrl, DATABASE_URL: appUrl };
  execSync('pnpm --filter @jantrik/db exec prisma migrate deploy', {
    cwd: root,
    env,
    stdio: 'pipe',
  });
  execSync('pnpm --filter @jantrik/db db:seed', { cwd: root, env, stdio: 'pipe' });

  const redis = new Redis(E2E_REDIS_URL);
  try {
    await redis.flushdb();
  } finally {
    await redis.quit();
  }
}

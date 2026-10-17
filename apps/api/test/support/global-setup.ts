import { execSync } from 'node:child_process';
import path from 'node:path';
import { config } from 'dotenv';
import { createPrismaClient, seedTemplates } from '@jantrik/db';
import { Redis } from 'ioredis';

/**
 * Migrate the test database (non-destructive), load templates, and flush the test Redis DB.
 * Runs once before all api e2e tests.
 */
export default async function setup(): Promise<void> {
  config({ path: path.resolve(import.meta.dirname, '../../../../.env'), quiet: true });
  const ownerUrl = process.env['DATABASE_MIGRATION_URL_TEST'];
  const redisUrl = process.env['REDIS_URL_TEST'] ?? 'redis://localhost:6379/1';
  if (!ownerUrl || !new URL(ownerUrl).pathname.endsWith('_test')) {
    throw new Error('DATABASE_MIGRATION_URL_TEST must point at a *_test database');
  }
  if (!/\/([1-9]|1[0-5])$/.test(redisUrl)) {
    throw new Error('REDIS_URL_TEST must select a non-zero Redis database (it is flushed)');
  }

  execSync('pnpm --filter @jantrik/db exec prisma migrate deploy', {
    cwd: path.resolve(import.meta.dirname, '../../../..'),
    env: { ...process.env, DATABASE_MIGRATION_URL: ownerUrl },
    stdio: 'pipe',
  });

  const owner = createPrismaClient(ownerUrl);
  try {
    await seedTemplates(owner);
  } finally {
    await owner.$disconnect();
  }

  const redis = new Redis(redisUrl);
  try {
    await redis.flushdb();
  } finally {
    await redis.quit();
  }
}

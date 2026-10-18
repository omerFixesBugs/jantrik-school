import { execSync } from 'node:child_process';
import path from 'node:path';
import { Redis } from 'ioredis';
import { E2E_REDIS_URL } from '../playwright.config';

const E2E_DATABASE = 'jantrik_e2e';

/** True only for a connection URL whose database is exactly jantrik_e2e. */
const isE2eDatabase = (url: string | undefined): boolean => {
  if (!url) return false;
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) === E2E_DATABASE;
  } catch {
    return false;
  }
};

/**
 * Every run starts from the same data: drop and re-migrate jantrik_e2e, seed it, and flush the
 * e2e Redis DB (SMS outbox, rate-limit counters). Refuses any database not named jantrik_e2e.
 */
export default async function globalSetup(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '../../..');
  const ownerUrl = process.env['DATABASE_MIGRATION_URL_E2E'];
  const appUrl = process.env['DATABASE_URL_E2E'];
  if (!isE2eDatabase(ownerUrl) || !isE2eDatabase(appUrl)) {
    throw new Error(`DATABASE_URL_E2E / DATABASE_MIGRATION_URL_E2E must point at ${E2E_DATABASE}`);
  }
  if (!/\/([1-9]|1[0-5])$/.test(E2E_REDIS_URL)) {
    throw new Error('REDIS_URL_E2E must select a non-zero Redis database (it is flushed)');
  }

  const env = { ...process.env, DATABASE_MIGRATION_URL: ownerUrl, DATABASE_URL: appUrl };
  // Prisma 7's reset applies every migration but does not seed; the seed is the next step.
  execSync('pnpm --filter @jantrik/db exec prisma migrate reset --force', {
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

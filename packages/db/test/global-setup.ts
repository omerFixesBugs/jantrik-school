import { execSync } from 'node:child_process';
import path from 'node:path';
import { createPrismaClient } from '../src/index.js';
import { seedTemplates } from '../src/seed/templates.js';
import { OWNER_URL } from './env.js';

/**
 * Bring the test database up to date and load the global templates. Non-destructive: tests
 * create their own tenants with random slugs, so the database never needs to be wiped.
 */
export default async function setup(): Promise<void> {
  execSync('pnpm exec prisma migrate deploy', {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATABASE_MIGRATION_URL: OWNER_URL },
    stdio: 'pipe',
  });

  const owner = createPrismaClient(OWNER_URL);
  try {
    await seedTemplates(owner);
  } finally {
    await owner.$disconnect();
  }
}

import path from 'node:path';
import { config } from 'dotenv';
import { createPrismaClient } from '../index.js';
import { seedDemo } from './demo.js';
import { seedPlatformAdmin } from './platform.js';
import { maySeedPlatformAdmin } from './reset-guard.js';
import { seedTemplates } from '../reference-data/templates.js';

// Seeds global templates (as the owner role) and demo tenants (as the RLS-restricted app role).
// Run with `pnpm db:seed`.

config({ path: path.resolve(import.meta.dirname, '../../../../.env'), quiet: true });

// Demo tenants and the demo staff password must never reach a real database.
if (process.env['NODE_ENV'] === 'production') {
  console.error('Refusing to seed: NODE_ENV=production. The seed is for development only.');
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

const owner = createPrismaClient(requireEnv('DATABASE_MIGRATION_URL'));
const app = createPrismaClient(requireEnv('DATABASE_URL'));

try {
  console.log('Seeding institute types, templates and grading schemes...');
  await seedTemplates(owner);
  console.log('Seeding demo tenants...');
  await seedDemo(app);
  if (maySeedPlatformAdmin(process.env)) {
    console.log('Seeding the development platform admin...');
    await seedPlatformAdmin(owner);
  } else {
    console.log(
      'Skipping the development platform admin: not the local dev or e2e database. ' +
        'Create platform admins with `pnpm platform:admin create` (docs/platform.md).',
    );
  }
  console.log('Done.');
} finally {
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
}

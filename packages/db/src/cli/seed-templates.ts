import path from 'node:path';
import { config } from 'dotenv';
import { createPrismaClient } from '../index.js';
import { seedTemplates } from '../reference-data/templates.js';

// `node dist/cli/seed-templates.js`: loads the global reference data (institute types, their
// templates and the grading schemes, src/reference-data/templates.ts) as the owner role
// (DATABASE_MIGRATION_URL). Production runs it right after `prisma migrate deploy` (the migrate
// step, docs/deploy.md): no institute can be registered before its type exists. Idempotent
// (upserts); it touches no institute's rows. `pnpm db:seed` does the same plus demo data, so that
// one refuses production; this one does not.
config({ path: path.resolve(import.meta.dirname, '../../../../.env'), quiet: true });

const url = process.env['DATABASE_MIGRATION_URL'];
if (!url) {
  console.error('DATABASE_MIGRATION_URL is not set (the owner role connection).');
  process.exit(1);
}
const prisma = createPrismaClient(url);
try {
  await seedTemplates(prisma);
  console.log('Institute types, templates and grading schemes are up to date.');
} catch (error) {
  // Its name and code only: the message could carry the connection string.
  const { name, code } = error as Error & { code?: unknown };
  console.error(`Failed to load the templates: ${name}${code ? ` (${String(code)})` : ''}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

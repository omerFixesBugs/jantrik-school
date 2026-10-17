import path from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Single root .env for the whole monorepo.
config({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx src/seed/index.ts',
  },
  datasource: {
    // Migrations run as the schema owner, never as the RLS-restricted app role.
    url: process.env['DATABASE_MIGRATION_URL'] ?? '',
  },
});

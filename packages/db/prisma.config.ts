import path from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Single root .env for the whole monorepo.
config({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});

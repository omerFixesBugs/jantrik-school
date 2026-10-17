import path from 'node:path';
import { config } from 'dotenv';

config({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

function testUrl(name: 'DATABASE_URL_TEST' | 'DATABASE_MIGRATION_URL_TEST'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  // Guard: the global setup wipes this database.
  if (!new URL(value).pathname.endsWith('_test')) {
    throw new Error(`${name} must point at a *_test database, got ${value}`);
  }
  return value;
}

/** Runtime role (RLS applies). */
export const APP_URL = testUrl('DATABASE_URL_TEST');
/** Schema owner (migrations, templates). */
export const OWNER_URL = testUrl('DATABASE_MIGRATION_URL_TEST');

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

/**
 * The API platform module's login (jantrik_platform_app: user and password of
 * DATABASE_PLATFORM_URL) on the test database; server, port and database come from APP_URL.
 */
export const PLATFORM_URL = (() => {
  const login = process.env['DATABASE_PLATFORM_URL'];
  if (!login) throw new Error('DATABASE_PLATFORM_URL is not set (see .env.example)');
  const url = new URL(APP_URL);
  url.username = new URL(login).username;
  url.password = new URL(login).password;
  return url.toString();
})();

/**
 * The cluster superuser on the test database, for tests that must create roles (the login
 * privilege check). DATABASE_SUPERUSER_URL_TEST (CI), or POSTGRES_USER and POSTGRES_PASSWORD from
 * the root .env on APP_URL's server and database. A function, so only the tests that need it fail
 * without it; they fail, never skip.
 */
export function superuserUrl(): string {
  const given = process.env['DATABASE_SUPERUSER_URL_TEST'];
  if (given) return given;
  const user = process.env['POSTGRES_USER'];
  const password = process.env['POSTGRES_PASSWORD'];
  if (!user || !password) {
    throw new Error(
      'Set DATABASE_SUPERUSER_URL_TEST (or POSTGRES_USER and POSTGRES_PASSWORD, see .env.example)',
    );
  }
  const url = new URL(APP_URL);
  url.username = user;
  url.password = password;
  return url.toString();
}

/**
 * The device receiver's login (jantrik_ingest_app: user and password of DATABASE_INGEST_URL) on
 * the test database; server, port and database come from APP_URL.
 */
export const INGEST_URL = (() => {
  const login = process.env['DATABASE_INGEST_URL'];
  if (!login) throw new Error('DATABASE_INGEST_URL is not set (see .env.example)');
  const url = new URL(APP_URL);
  url.username = new URL(login).username;
  url.password = new URL(login).password;
  return url.toString();
})();

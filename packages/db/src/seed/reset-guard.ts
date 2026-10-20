/**
 * Safety check for `pnpm db:reset`, which drops and recreates a database. It may only ever touch
 * the local development database created by docker/postgres/init (`jantrik` on this machine).
 * Test databases are managed by their own test setups; anything remote is never reset.
 */

/** The only database `db:reset` may drop. */
export const DEV_DATABASE = 'jantrik';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface ResetTarget {
  host: string;
  port: string;
  database: string;
}

function parse(name: string, url: string | undefined): ResetTarget {
  if (!url) throw new Error(`${name} is not set (see .env.example)`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} is not a valid connection URL`);
  }
  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };
}

/** Databases the seed may give the development platform admin (known password). */
export const PLATFORM_ADMIN_SEED_DATABASES = [DEV_DATABASE, 'jantrik_e2e'] as const;

/**
 * The seed's development platform admin has a published password and an open enrolment window:
 * whoever signs in first sets up the authenticator. So only on this machine's dev or e2e database
 * (never a staging or demo server, even when NODE_ENV is not production).
 */
export function maySeedPlatformAdmin(env: Record<string, string | undefined>): boolean {
  if (env['NODE_ENV'] === 'production') return false;
  let target: ResetTarget;
  try {
    target = parse('DATABASE_MIGRATION_URL', env['DATABASE_MIGRATION_URL']);
  } catch {
    return false;
  }
  return (
    LOCAL_HOSTS.has(target.host) &&
    (PLATFORM_ADMIN_SEED_DATABASES as readonly string[]).includes(target.database)
  );
}

/**
 * Throws unless every condition holds: not production, both connection URLs point at the same
 * database, the host is this machine, and the database is the dev database.
 */
export function assertLocalDevDatabase(env: Record<string, string | undefined>): ResetTarget {
  if (env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to reset: NODE_ENV=production.');
  }
  const migration = parse('DATABASE_MIGRATION_URL', env['DATABASE_MIGRATION_URL']);
  const app = parse('DATABASE_URL', env['DATABASE_URL']);

  if (
    migration.host !== app.host ||
    migration.port !== app.port ||
    migration.database !== app.database
  ) {
    throw new Error(
      'Refusing to reset: DATABASE_MIGRATION_URL and DATABASE_URL point at different databases ' +
        `(${migration.host}:${migration.port}/${migration.database} vs ` +
        `${app.host}:${app.port}/${app.database}).`,
    );
  }
  if (!LOCAL_HOSTS.has(migration.host)) {
    throw new Error(
      `Refusing to reset: host "${migration.host}" is not this machine. ` +
        'db:reset only works on the local Docker database.',
    );
  }
  if (migration.database !== DEV_DATABASE) {
    throw new Error(
      `Refusing to reset: database "${migration.database}" is not the local dev database ` +
        `"${DEV_DATABASE}". Test databases are reset by their own test setups.`,
    );
  }
  return migration;
}

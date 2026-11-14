/**
 * Settings a production server must never start with (NODE_ENV=production only; development and
 * tests are untouched). The API (env.ts), its worker and the device receiver (ingest-env.ts) apply
 * them at startup. Every rule is explained in docs/deploy.md → "Environment checks".
 */

export interface EnvProblem {
  path: string;
  message: string;
}

/**
 * Express `trust proxy` values that believe any client's X-Forwarded-For: `true`, or a range that
 * holds every address (`0.0.0.0/0`, `::/0`). A client could then claim any address: a school's
 * trusted one, or a fresh one per request past every per-address limit.
 */
export function trustsAnyClient(value: string): boolean {
  const parts = value
    .toLowerCase()
    .split(',')
    .map((p) => p.trim());
  return parts.some((p) => p === 'true' || p.endsWith('/0'));
}

const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|\[::\])$/i;

/** Why a browser origin may not be allowed in production, or null when it may. */
export function unsafeOrigin(origin: string): string | null {
  if (origin === '*') return 'a wildcard';
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return 'not https';
  if (LOCAL_HOST.test(url.hostname) || url.hostname.endsWith('.localhost')) {
    return 'a local address';
  }
  return null;
}

/**
 * Marks of example, development and test values (.env.example, deploy/.env.prod.example, CI and
 * the test configs): a secret carrying one was copied, not generated. The same list as
 * deploy/compose.sh and deploy/postgres/create-roles.sh.
 */
const PLACEHOLDER =
  /change[-_ ]?me|dev[-_]only|test[-_]only|ci[-_]only|dev_password|ci_password|placeholder|example/i;

export const isPlaceholderSecret = (value: string): boolean => PLACEHOLDER.test(value);

/** The login of a postgres:// or postgresql:// URL; null when the URL is not one or names none. */
export function databaseUser(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return null;
  return decodeURIComponent(parsed.username) || null;
}

/** The schema owner (migrations) and the cluster superuser: never a running service's login. */
const PRIVILEGED_DB_USERS = ['jantrik_owner', 'postgres'];

/** A runtime login that is missing, or privileged, or one of `refused`. */
export function databaseUrlProblem(
  path: string,
  url: string,
  refused: readonly string[] = PRIVILEGED_DB_USERS,
): EnvProblem | null {
  const user = databaseUser(url);
  if (!user) {
    return { path, message: `${path} must be a postgresql:// URL that names its login` };
  }
  if (refused.includes(user)) {
    return { path, message: `${path} must not log in as ${user} in production` };
  }
  return null;
}

/** Variables production must set itself: their defaults only suit a developer's machine. */
export function missingInProduction(
  config: Record<string, unknown>,
  keys: readonly string[],
): EnvProblem[] {
  return keys
    .filter((key) => typeof config[key] !== 'string' || (config[key] as string).trim() === '')
    .map((key) => ({ path: key, message: `${key} must be set in production` }));
}

/** Of `keys`, those the environment holds (non-empty), each refused with `why`. */
function givenInProduction(
  config: Record<string, unknown>,
  keys: readonly string[],
  why: (key: string) => string,
): EnvProblem[] {
  return keys
    .filter((key) => typeof config[key] === 'string' && (config[key] as string) !== '')
    .map((key) => ({ path: key, message: why(key) }));
}

/** At least this long: `openssl rand -hex 24` gives 48 characters. */
const MIN_PASSWORD = 24;

/**
 * A password inside a URL (REDIS_URL) that is an example value or short. A URL without one is
 * allowed: Redis reached only on a private network (the production compose always sets one).
 */
export function urlPasswordProblem(path: string, url: string): EnvProblem | null {
  let passwords: string[];
  try {
    const parsed = new URL(url);
    // ioredis also takes the password from the query string (?password=).
    passwords = [decodeURIComponent(parsed.password), parsed.searchParams.get('password') ?? ''];
  } catch {
    return null;
  }
  const weak = passwords.some(
    (p) => p !== '' && (p.length < MIN_PASSWORD || isPlaceholderSecret(p)),
  );
  if (!weak) return null;
  return {
    path,
    message: `${path} holds an example password or one under ${MIN_PASSWORD} characters: generate one (openssl rand -hex 24)`,
  };
}

/**
 * The schema owner's and the cluster superuser's credentials, and the roles' raw passwords: only
 * Postgres itself and the migrate step get them, never a running service.
 */
export const DATABASE_ADMIN_SECRETS = [
  'DATABASE_MIGRATION_URL',
  'POSTGRES_PASSWORD',
  'DB_OWNER_PASSWORD',
  'DB_APP_PASSWORD',
  'DB_PLATFORM_PASSWORD',
  'DB_INGEST_PASSWORD',
] as const;

/**
 * Production must set these itself: their defaults (Redis on localhost, no proxy in front) suit a
 * developer's machine only.
 */
export const API_PRODUCTION_REQUIRED = ['REDIS_URL', 'TRUST_PROXY'] as const;

/** The API's (and the worker's) production rules on what its environment holds (raw). */
export function apiEnvironmentProblems(config: Record<string, unknown>): EnvProblem[] {
  return [
    ...missingInProduction(config, API_PRODUCTION_REQUIRED),
    ...givenInProduction(
      config,
      DATABASE_ADMIN_SECRETS,
      (key) =>
        `${key} must not be given to the API or the worker in production (only Postgres and the migrate step use it)`,
    ),
  ];
}

/** The API values checked in production (env.ts, before its defaults are filled in). */
export interface ApiProductionEnv {
  SMS_PROVIDER: string;
  TRUST_PROXY: string;
  INGEST_TRUST_PROXY: string;
  INGEST_IN_PROCESS?: boolean | undefined;
  CORS_ORIGINS: string[];
  REDIS_URL: string;
  JWT_ACCESS_SECRET: string;
  OTP_PEPPER: string;
  PLATFORM_TOTP_KEY?: string | undefined;
  DATABASE_URL: string;
  DATABASE_PLATFORM_URL: string;
  DATABASE_INGEST_URL?: string | undefined;
}

/** SMS providers for development and tests only (console prints codes, the others keep them). */
const DEV_SMS_PROVIDERS = ['console', 'memory', 'outbox'];

const SECRETS = ['JWT_ACCESS_SECRET', 'OTP_PEPPER', 'PLATFORM_TOTP_KEY'] as const;

/**
 * The API's (and the worker's) production rules. COOKIE_SECURE, DEV_LAN, JANTRIK_TEST_TODAY,
 * PLATFORM_TOTP_KEY and INGEST_PUBLIC_HOST are checked in env.ts itself.
 */
export function apiProductionProblems(env: ApiProductionEnv): EnvProblem[] {
  const problems: EnvProblem[] = [];
  const add = (path: string, message: string) => problems.push({ path, message });

  if (DEV_SMS_PROVIDERS.includes(env.SMS_PROVIDER)) {
    add(
      'SMS_PROVIDER',
      `SMS_PROVIDER=${env.SMS_PROVIDER} is for development and tests only (it prints or keeps every code); use "none" until a real gateway is built`,
    );
  }
  for (const key of ['TRUST_PROXY', 'INGEST_TRUST_PROXY'] as const) {
    if (trustsAnyClient(env[key])) {
      add(
        key,
        `${key} must be false, a hop count (e.g. 1) or the proxy's address in production, never true: any client could claim any address`,
      );
    }
  }
  if (env.INGEST_IN_PROCESS) {
    add(
      'INGEST_IN_PROCESS',
      'INGEST_IN_PROCESS must not be true in production: the device receiver runs as its own process (ingest-main.js) without the API logins and secrets',
    );
  }
  if (env.CORS_ORIGINS.length === 0) add('CORS_ORIGINS', 'CORS_ORIGINS must list the web origins');
  for (const origin of env.CORS_ORIGINS) {
    const why = unsafeOrigin(origin);
    if (why) {
      add('CORS_ORIGINS', `CORS_ORIGINS must hold https origins only; "${origin}" is ${why}`);
    }
  }
  const secrets = SECRETS.filter((key) => env[key] !== undefined);
  for (const key of secrets) {
    if (isPlaceholderSecret(env[key]!)) {
      add(key, `${key} is an example value: generate one (openssl rand -base64 48)`);
    }
  }
  for (const [i, a] of secrets.entries()) {
    for (const b of secrets.slice(i + 1)) {
      if (env[a] === env[b]) add(b, `${b} must differ from ${a}: one secret per purpose`);
    }
  }
  for (const key of ['DATABASE_URL', 'DATABASE_PLATFORM_URL', 'DATABASE_INGEST_URL'] as const) {
    const url = env[key];
    if (url === undefined) continue;
    const problem = databaseUrlProblem(key, url);
    if (problem) problems.push(problem);
  }
  const redis = urlPasswordProblem('REDIS_URL', env.REDIS_URL);
  if (redis) problems.push(redis);
  return problems;
}

/** The device receiver's values checked in production (ingest-env.ts). */
export interface ReceiverProductionEnv {
  DATABASE_INGEST_URL: string;
  REDIS_URL: string;
  INGEST_TRUST_PROXY: string;
}

/**
 * The API's logins and secrets: the receiver, open to the internet without a login, must never be
 * given them (docs/decisions-pending.md → Deployment requirements, item 4).
 */
export const API_ONLY_SECRETS = [
  'DATABASE_URL',
  'DATABASE_PLATFORM_URL',
  'DATABASE_MIGRATION_URL',
  'JWT_ACCESS_SECRET',
  'OTP_PEPPER',
  'PLATFORM_TOTP_KEY',
] as const;

/** The receiver's production rules on its parsed values. */
export function receiverProductionProblems(env: ReceiverProductionEnv): EnvProblem[] {
  const problems: EnvProblem[] = [];
  if (trustsAnyClient(env.INGEST_TRUST_PROXY)) {
    problems.push({
      path: 'INGEST_TRUST_PROXY',
      message:
        "INGEST_TRUST_PROXY must be false (devices connect directly), a hop count or the proxy's address in production, never true: a client could claim a school's trusted address",
    });
  }
  // Only its own login: never one that can choose an institute or run the platform functions.
  const problem = databaseUrlProblem('DATABASE_INGEST_URL', env.DATABASE_INGEST_URL, [
    ...PRIVILEGED_DB_USERS,
    'jantrik_app',
    'jantrik_platform_app',
  ]);
  if (problem) problems.push(problem);
  const redis = urlPasswordProblem('REDIS_URL', env.REDIS_URL);
  if (redis) problems.push(redis);
  return problems;
}

/** The receiver's production rules on what its environment holds (raw, before parsing). */
export function receiverEnvironmentProblems(config: Record<string, unknown>): EnvProblem[] {
  const refused = [...new Set<string>([...API_ONLY_SECRETS, ...DATABASE_ADMIN_SECRETS])];
  return [
    ...missingInProduction(config, ['REDIS_URL']),
    ...givenInProduction(
      config,
      refused,
      (key) =>
        `${key} must not be given to the device receiver in production (it belongs to the API or the database)`,
    ),
  ];
}

/** Problems in the format of zod's prettifyError, so both read alike in the log. */
export const formatProblems = (problems: readonly EnvProblem[]): string =>
  problems.map((p) => `✖ ${p.message}\n  → at ${p.path}`).join('\n');

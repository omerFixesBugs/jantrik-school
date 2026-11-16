import { createHmac } from 'node:crypto';
import type { PrismaClient, TransactionClient } from '../client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(kind: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new TypeError(`Invalid ${kind} id: ${JSON.stringify(value)}`);
  }
}

export function assertTenantId(tenantId: string): void {
  assertUuid('tenant', tenantId);
}

/** Transaction client handed to `withTenant` / `withContext` callbacks. */
export type TenantTx = TransactionClient;

/** RLS context: the institute and/or the person. Unset means "nothing visible". */
export interface DbContext {
  tenantId?: string | null;
  userId?: string | null;
}

export interface TxOptions {
  timeout?: number;
  maxWait?: number;
}

// ───────────── The request context key (P1-J8) ─────────────
// The database believes a context only when it is signed with this key for the very transaction
// it is used in (docs/database.md → The request context). The key lives in the database
// (app_context_key, made by its migration); a process reads it once, through a source it
// registers at start-up: the API and the worker through the password-login login
// (`loadRequestContextKey`, LoginPrismaService), the seed and the tests as the schema owner
// (`loadRequestContextKeyAsOwner`).

/** Where this process gets the request context key. */
export type RequestContextKeySource = () => Promise<Uint8Array>;

let keySource: RequestContextKeySource | null = null;
let keyPromise: Promise<Buffer> | null = null;

/**
 * Register where the request context key comes from. Called once at start-up (the API's
 * LoginPrismaService constructor, the seed, the test setup); a later call replaces the source and
 * forgets a key already loaded.
 */
export function setRequestContextKeySource(source: RequestContextKeySource): void {
  keySource = source;
  keyPromise = null;
}

/**
 * The request context key, loaded once from the registered source. Rejects when no source is
 * registered, or the source fails (a failed load is tried again on the next call).
 */
export function requestContextKey(): Promise<Buffer> {
  if (keyPromise) return keyPromise;
  const source = keySource;
  if (!source) {
    return Promise.reject(
      new Error(
        'The request context key is not loaded: register its source at start-up ' +
          '(setRequestContextKeySource, docs/database.md → The request context).',
      ),
    );
  }
  const loading = source().then((raw) => {
    const key = Buffer.from(raw);
    if (key.length < 32) throw new Error('The request context key is too short.');
    return key;
  });
  keyPromise = loading;
  loading.catch(() => {
    if (keyPromise === loading) keyPromise = null;
  });
  return loading;
}

/**
 * Read the key through `auth_context_key()`, which only the password-login login
 * (jantrik_login_app, DATABASE_LOGIN_URL) may run.
 */
export async function loadRequestContextKey(loginClient: PrismaClient): Promise<Buffer> {
  const [row] = await loginClient.$queryRaw<{ key: Uint8Array | null }[]>`
    SELECT auth_context_key() AS key`;
  if (!row?.key) throw new Error('auth_context_key() returned no key: run the migrations.');
  return Buffer.from(row.key);
}

/** Read the key from its table as the schema owner (DATABASE_MIGRATION_URL): seed and tests. */
export async function loadRequestContextKeyAsOwner(ownerClient: PrismaClient): Promise<Buffer> {
  const [row] = await ownerClient.$queryRaw<{ key: Uint8Array }[]>`
    SELECT key FROM app_context_key WHERE id = 1`;
  if (!row?.key) throw new Error('app_context_key has no key: run the migrations.');
  return Buffer.from(row.key);
}

/** What a signed context names: the institute, the person, and the transaction it is valid in. */
export interface SignedContextParts {
  tenantId: string | null;
  userId: string | null;
  /** `pg_backend_pid()` of the transaction's connection. */
  pid: string;
  /** The transaction's start (`now()`), in microseconds since 1970, as decimal digits. */
  startedMicros: string;
}

/**
 * The value of `app.context`: `v1:<tenant>:<user>:<pid>:<µs>:<HMAC-SHA256 hex>`. Exported for the
 * tests; the app only signs through `withContext`.
 */
export function signRequestContext(key: Uint8Array, parts: SignedContextParts): string {
  const message = [
    'v1',
    parts.tenantId?.toLowerCase() ?? '',
    parts.userId?.toLowerCase() ?? '',
    parts.pid,
    parts.startedMicros,
  ].join(':');
  return `${message}:${createHmac('sha256', key).update(message, 'utf8').digest('hex')}`;
}

/** Sign and set the context for the transaction `tx` runs in. */
async function setSignedContext(
  tx: TenantTx,
  key: Buffer,
  tenantId: string | null,
  userId: string | null,
): Promise<void> {
  const [here] = await tx.$queryRaw<{ pid: string; started: string }[]>`
    SELECT pg_backend_pid()::text AS pid,
           (extract(epoch FROM now()) * 1000000)::bigint::text AS started`;
  if (!here) throw new Error('Could not read the transaction to sign its context.');
  const value = signRequestContext(key, {
    tenantId,
    userId,
    pid: here.pid,
    startedMicros: here.started,
  });
  await tx.$executeRaw`SELECT set_config('app.context', ${value}, true)`;
}

/**
 * Run `fn` in one transaction with the given RLS context.
 *
 * The context is signed for this transaction (its connection's backend and its start) and set
 * with `set_config(name, value, true)`, the parameter-safe form of `SET LOCAL`: it lasts only until
 * the transaction ends, so pooled connections never leak a tenant or user to the next request,
 * and no SQL in the transaction can replace it with another person or institute (P1-J8).
 * Use this for any multi-step unit of work and for raw SQL.
 */
export async function withContext<T>(
  prisma: PrismaClient,
  context: DbContext,
  fn: (tx: TenantTx) => Promise<T>,
  options?: TxOptions,
): Promise<T> {
  const { tenantId, userId } = context;
  if (tenantId) assertUuid('tenant', tenantId);
  if (userId) assertUuid('user', userId);
  // Loaded before the transaction opens, so a first load never holds a connection.
  const key = tenantId || userId ? await requestContextKey() : null;
  return prisma.$transaction(async (tx) => {
    if (key) await setSignedContext(tx, key, tenantId || null, userId || null);
    return fn(tx);
  }, options);
}

/** `withContext` with only a tenant. */
export async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options?: TxOptions,
): Promise<T> {
  assertTenantId(tenantId);
  return withContext(prisma, { tenantId }, fn, options);
}

type ModelDelegates = Record<string, Record<string, (args: unknown) => Promise<unknown>>>;

/**
 * A client whose every model operation runs in its own short transaction scoped to `tenantId`
 * (a `withTenant` per call). Convenient for single queries (`db.student.findMany()`); for several
 * related writes use `withTenant` so they share one transaction. Raw queries (`$queryRaw`) are
 * NOT scoped by this extension — use `withTenant` for those.
 */
export function tenantClient(prisma: PrismaClient, tenantId: string) {
  assertTenantId(tenantId);
  return prisma.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args }) {
          const delegate = model.charAt(0).toLowerCase() + model.slice(1);
          return withTenant(prisma, tenantId, (tx) => {
            const target = (tx as unknown as ModelDelegates)[delegate];
            if (typeof target?.[operation] !== 'function') {
              throw new Error(`tenantClient: no ${delegate}.${operation}`);
            }
            return target[operation](args);
          });
        },
      },
    },
  });
}

export type TenantClient = ReturnType<typeof tenantClient>;

import type { Prisma, PrismaClient } from '../generated/prisma/client.js';

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
export type TenantTx = Prisma.TransactionClient;

/** RLS context: `app.tenant_id` and/or `app.user_id`. Unset means "nothing visible". */
export interface DbContext {
  tenantId?: string | null;
  userId?: string | null;
}

export interface TxOptions {
  timeout?: number;
  maxWait?: number;
}

/**
 * Run `fn` in one transaction with the given RLS context.
 *
 * `set_config(name, value, true)` is the parameter-safe form of `SET LOCAL`: it lasts only until
 * the transaction ends, so pooled connections never leak a tenant or user to the next request.
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
  return prisma.$transaction(async (tx) => {
    if (tenantId) await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    if (userId) await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
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

/**
 * A client whose every model operation runs in its own short transaction scoped to `tenantId`.
 * Convenient for single queries (`db.student.findMany()`); for several related writes use
 * `withTenant` so they share one transaction. Raw queries (`$queryRaw`) are NOT scoped by this
 * extension — use `withTenant` for those.
 */
export function tenantClient(prisma: PrismaClient, tenantId: string) {
  assertTenantId(tenantId);
  return prisma.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const [, result] = await prisma.$transaction([
            prisma.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
            query(args),
          ]);
          return result;
        },
      },
    },
  });
}

export type TenantClient = ReturnType<typeof tenantClient>;

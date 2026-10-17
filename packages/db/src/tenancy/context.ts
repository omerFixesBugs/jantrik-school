import type { Prisma, PrismaClient } from '../generated/prisma/client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertTenantId(tenantId: string): void {
  if (!UUID_RE.test(tenantId)) {
    throw new TypeError(`Invalid tenant id: ${JSON.stringify(tenantId)}`);
  }
}

/** Transaction client handed to `withTenant` callbacks. */
export type TenantTx = Prisma.TransactionClient;

/**
 * Run `fn` in one transaction whose RLS context is `tenantId`.
 *
 * `set_config('app.tenant_id', id, true)` is the parameter-safe form of `SET LOCAL`: it lasts
 * only until the transaction ends, so pooled connections never leak a tenant to the next user.
 * Use this for any multi-step unit of work and for raw SQL.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options?: { timeout?: number; maxWait?: number },
): Promise<T> {
  assertTenantId(tenantId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }, options);
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

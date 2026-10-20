import type { PrismaClient } from '../generated/prisma/client.js';
import type { TenantTx, TxOptions } from '../tenancy/context.js';

const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Run `fn` in one transaction as a platform admin: `app.platform_session` is the session
 * token's hash. Only the platform_* SECURITY DEFINER functions read it, and they refuse unless
 * it names a live session of an active admin. No tenant is set, so tenant tables show nothing.
 */
export async function withPlatformSession<T>(
  prisma: PrismaClient,
  tokenHash: string,
  fn: (tx: TenantTx) => Promise<T>,
  options?: TxOptions,
): Promise<T> {
  if (!TOKEN_HASH_RE.test(tokenHash)) throw new TypeError('Invalid platform session hash');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_session', ${tokenHash}, true)`;
    return fn(tx);
  }, options);
}

import { PrismaPg } from '@prisma/adapter-pg';
import type * as runtime from '@prisma/client/runtime/client';
import pg from 'pg';
import { PrismaClient as GeneratedPrismaClient, type Prisma } from './generated/prisma/client.js';

/**
 * Columns every client leaves out of its reads unless a query asks for them (P1-J). The app
 * login may not SELECT `users.password_hash` (docs/database.md → users), so a read or an update
 * that returned the whole row would be refused by the database; with the column omitted, Prisma
 * never names it. The owner login can still read it with `omit: { passwordHash: false }` on one
 * query (tests only).
 *
 * An institute's encrypted gateway credentials (sprint 1 P7a) likewise: only the API's
 * PaymentCredentialsService asks for them (`select`), so no other read ever carries them.
 */
export const CLIENT_OMIT = {
  user: { passwordHash: true },
  paymentGatewayAccount: { credentialsCiphertext: true },
} as const satisfies Prisma.GlobalOmitConfig;

/** The Prisma client of this package: always built by `createPrismaClient`, so `CLIENT_OMIT` applies. */
export type PrismaClient = GeneratedPrismaClient<never, typeof CLIENT_OMIT>;

/** The client a `$transaction` callback receives. */
export type TransactionClient = Omit<PrismaClient, runtime.ITXClientDenyList>;

/** Connection pool settings a caller may set (node-postgres; none by default). */
export interface PoolOptions {
  /**
   * How long getting a connection may take before it fails (default: no limit): opening a new
   * one, and also waiting for a free one while the pool is full (at most 10 connections).
   */
  connectionTimeoutMillis?: number;
  /** TCP keep-alive on the pool's connections (default: off). */
  keepAlive?: boolean;
  /**
   * Idle time before the first keep-alive probe. Without it node-postgres passes 0, which keeps
   * the operating system's default (about 2 hours on Linux and Windows).
   */
  keepAliveInitialDelayMillis?: number;
  /**
   * Milliseconds a statement may run before the server cancels it (error 57014; default: no
   * limit). Sent when each connection opens, so the server enforces it.
   */
  statement_timeout?: number;
  /** Most connections in the pool (default 10). */
  max?: number;
}

type StatusClient = pg.PoolClient & { getTransactionStatus?: () => string | null };

/**
 * A pool that never hands a connection out again with a transaction still open (P1-J8 review).
 * SQL sent outside a Prisma transaction may hold several statements; an injection there could end
 * with `BEGIN; DECLARE c CURSOR WITH HOLD FOR …`, leaving its transaction open when the connection
 * goes back to the pool. The next request's BEGIN would only warn, its signed context would sign
 * the attacker's transaction, and the cursor would be filled at its COMMIT with that request's
 * data. On release, a connection that is not idle (`I`: no transaction) is closed instead of
 * pooled. `onDiscard` is told (tests count it).
 */
export function guardedPool(
  config: pg.PoolConfig,
  onDiscard?: (status: string | null) => void,
): pg.Pool {
  const pool = new pg.Pool(config);
  pool.on('release', (err: Error | undefined, client: StatusClient) => {
    if (err) return; // pg-pool closes a client released with an error itself
    const status = client.getTransactionStatus?.() ?? null;
    if (status === 'I') return;
    onDiscard?.(status);
    // Marks it ending before pg-pool decides: it is removed, never handed out again.
    client.end().catch(() => undefined);
  });
  return pool;
}

/**
 * PrismaPg whose every connect (the first one, and any after a `$disconnect`) builds a fresh
 * guarded pool, and whose `$disconnect` ends it.
 */
class GuardedPrismaPg extends PrismaPg {
  constructor(private readonly poolConfig: pg.PoolConfig) {
    super(poolConfig);
  }

  override connect(): ReturnType<PrismaPg['connect']> {
    return new PrismaPg(guardedPool(this.poolConfig), { disposeExternalPool: true }).connect();
  }
}

/** Create a Prisma client bound to the given Postgres connection string. */
export function createPrismaClient(connectionString: string, pool: PoolOptions = {}): PrismaClient {
  return new GeneratedPrismaClient({
    adapter: new GuardedPrismaPg({ connectionString, ...pool }),
    omit: CLIENT_OMIT,
  });
}

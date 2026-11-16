import { PrismaPg } from '@prisma/adapter-pg';
import type * as runtime from '@prisma/client/runtime/client';
import { PrismaClient as GeneratedPrismaClient, type Prisma } from './generated/prisma/client.js';

/**
 * Columns every client leaves out of its reads unless a query asks for them (P1-J). The app
 * login may not SELECT `users.password_hash` (docs/database.md → users), so a read or an update
 * that returned the whole row would be refused by the database; with the column omitted, Prisma
 * never names it. The owner login can still read it with `omit: { passwordHash: false }` on one
 * query (tests only).
 */
export const CLIENT_OMIT = {
  user: { passwordHash: true },
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

/** Create a Prisma client bound to the given Postgres connection string. */
export function createPrismaClient(connectionString: string, pool: PoolOptions = {}): PrismaClient {
  return new GeneratedPrismaClient({
    adapter: new PrismaPg({ connectionString, ...pool }),
    omit: CLIENT_OMIT,
  });
}

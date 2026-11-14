import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export { PrismaClient };
export * from './generated/prisma/client.js';
export * from './platform/context.js';
export * from './platform/secrets.js';
export * from './platform/totp.js';
export * from './tenancy/context.js';
export * from './tenancy/provision.js';
export * from './tenancy/search.js';
export * from './tenancy/users.js';
export { seedTemplates } from './reference-data/templates.js';

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
}

/** Create a Prisma client bound to the given Postgres connection string. */
export function createPrismaClient(connectionString: string, pool: PoolOptions = {}): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, ...pool }) });
}

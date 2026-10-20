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

/** Create a Prisma client bound to the given Postgres connection string. */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

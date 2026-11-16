// The package's PrismaClient is the type of what `createPrismaClient` returns (users.password_hash
// omitted from reads, P1-J); the generated class itself is not exported, so every client is built
// by the factory.
export {
  CLIENT_OMIT,
  createPrismaClient,
  type PoolOptions,
  type PrismaClient,
  type TransactionClient,
} from './client.js';
export * from './generated/prisma/client.js';
export * from './login-privileges.js';
export * from './platform/context.js';
export * from './platform/secrets.js';
export * from './platform/totp.js';
export * from './tenancy/context.js';
export * from './tenancy/provision.js';
export * from './tenancy/search.js';
export * from './tenancy/users.js';
export { seedTemplates } from './reference-data/templates.js';

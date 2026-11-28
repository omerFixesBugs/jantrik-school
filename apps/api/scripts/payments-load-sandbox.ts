import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrismaClient, withTenant } from '@jantrik/db';
import { sslcommerzCredentialsSchema, type SslcommerzCredentials } from '@jantrik/shared';
import type { ConfigService } from '@nestjs/config';
import { config } from 'dotenv';
import type { Env } from '../src/config/env.js';
import { PaymentCredentialsService } from '../src/payments/payment-credentials.service.js';
import type { Db } from '../src/tenancy/db.service.js';

/*
 * `pnpm --filter @jantrik/api payments:load-sandbox -- --tenant shapla-school` (sprint 1 P7a,
 * docs/payments.md → Commands): development only. Encrypts the owner's sandbox store
 * (SSLCOMMERZ_SANDBOX_STORE_ID and _PASSWORD in the root .env) onto one institute's SSLCommerz
 * account in the local `jantrik` database, off and untested, through PaymentCredentialsService
 * (the only code that writes the ciphertext). Audited with no person and `source: load-sandbox`.
 * Refuses production, a database that is not this machine's, and any database but `jantrik`
 * (the db:reset guard's rules).
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DEV_DATABASE = 'jantrik';
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type LoadStart =
  | { kind: 'refuse'; message: string }
  | { kind: 'run'; slug: string; creds: SslcommerzCredentials; databaseUrl: string };

/** The institute named by `--tenant <slug>` or `--tenant=<slug>`. */
function tenantArg(argv: readonly string[]): string | null {
  for (const [i, arg] of argv.entries()) {
    if (arg === '--tenant') return argv[i + 1] ?? null;
    if (arg.startsWith('--tenant=')) return arg.slice('--tenant='.length);
  }
  return null;
}

/** Whether to run, from the environment and the arguments. Messages never repeat a secret. */
export function loadSandboxStart(
  env: Record<string, string | undefined>,
  argv: readonly string[],
): LoadStart {
  const refuse = (message: string): LoadStart => ({
    kind: 'refuse',
    message: `Refusing: ${message}`,
  });
  if (env['NODE_ENV'] === 'production') return refuse('NODE_ENV=production.');
  const slug = tenantArg(argv);
  if (!slug || !SLUG.test(slug)) {
    return refuse('name the institute: --tenant <slug> (e.g. --tenant shapla-school).');
  }
  const creds = sslcommerzCredentialsSchema.safeParse({
    storeId: env['SSLCOMMERZ_SANDBOX_STORE_ID']?.trim() ?? '',
    storePassword: env['SSLCOMMERZ_SANDBOX_STORE_PASSWORD'] ?? '',
  });
  if (!creds.success) {
    return refuse(
      'set SSLCOMMERZ_SANDBOX_STORE_ID and SSLCOMMERZ_SANDBOX_STORE_PASSWORD in the root .env (your sandbox store).',
    );
  }
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) return refuse('DATABASE_URL is not set (see .env.example).');
  let target: URL;
  try {
    target = new URL(databaseUrl);
  } catch {
    return refuse('DATABASE_URL is not a valid connection URL.');
  }
  if (!LOCAL_HOSTS.has(target.hostname)) {
    return refuse(`host "${target.hostname}" is not this machine: only the local Docker database.`);
  }
  const database = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (database !== DEV_DATABASE) {
    return refuse(
      `database "${database}" is not the local development database "${DEV_DATABASE}".`,
    );
  }
  return { kind: 'run', slug, creds: creds.data, databaseUrl };
}

async function main(): Promise<void> {
  config({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });
  const start = loadSandboxStart(process.env, process.argv.slice(2));
  if (start.kind === 'refuse') {
    console.error(start.message);
    process.exitCode = 1;
    return;
  }
  const prisma = createPrismaClient(start.databaseUrl);
  try {
    const [tenant] = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM auth_resolve_tenant(${start.slug})`;
    if (!tenant) {
      console.error(`No institute "${start.slug}" in this database.`);
      process.exitCode = 1;
      return;
    }
    // The API's own key derivation (PAYMENT_CREDENTIALS_KEY, else from OTP_PEPPER).
    const env = {
      get: (key: keyof Env) => process.env[key as string],
    } as unknown as ConfigService<Env, true>;
    const hint = await withTenant(prisma, tenant.id, async (tx) => {
      const credentials = new PaymentCredentialsService({ tx } as unknown as Db, env);
      const existing = await tx.paymentGatewayAccount.findUnique({
        where: { tenantId_provider: { tenantId: tenant.id, provider: 'SSLCOMMERZ' } },
        select: { id: true, enabled: true },
      });
      const account =
        existing ??
        (await tx.paymentGatewayAccount.create({
          data: { tenantId: tenant.id, provider: 'SSLCOMMERZ' },
          select: { id: true, enabled: true },
        }));
      await credentials.save(account.id, start.creds, { actorUserId: null, now: new Date() });
      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          actorUserId: null,
          entity: 'payment_gateway_account',
          entityId: account.id,
          action: existing ? 'UPDATE' : 'CREATE',
          ...(existing ? { oldValues: { enabled: existing.enabled } } : {}),
          newValues: {
            changed: ['storeId', 'storePassword'],
            enabled: false,
            source: 'load-sandbox',
          },
        },
        select: { id: true },
      });
      return credentials.hint(start.creds.storeId);
    });
    console.log(
      `Loaded the sandbox store (••••${hint}) onto ${start.slug}: off and untested. Sign in as its owner, open Fees → Setup → Online payments, test the connection and turn it on.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

/** Run by tsx as a command (not imported by a test). Paths compared without case (Windows). */
const entry = process.argv[1];
if (entry && path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  void main();
}

import { randomBytes, randomUUID } from 'node:crypto';
import { todayIn } from '@jantrik/shared';
import {
  createPrismaClient,
  hashPlatformToken,
  loadRequestContextKeyAsOwner,
  provisionTenant,
  requestContextKey,
  setRequestContextKeySource,
  signRequestContext,
  withTenant,
  type PrismaClient,
  type ProvisionTenantInput,
  type Tenant,
  type TenantTx,
} from '../src/index.js';
import { APP_URL, INGEST_URL, LOGIN_URL, OWNER_URL, PLATFORM_URL } from './env.js';
import { phoneSource } from './test-phones.js';

// Every test file signs its institute contexts with the test database's key (P1-J8), read once
// per file as the schema owner (the API reads it through the password-login login instead).
setRequestContextKeySource(async () => {
  const owner = createPrismaClient(OWNER_URL, { max: 1 });
  try {
    return await loadRequestContextKeyAsOwner(owner);
  } finally {
    await owner.$disconnect();
  }
});

/**
 * Sign and set an institute context inside a transaction that is already open, for tests that
 * switch role first (SET LOCAL ROLE jantrik_ingest). The app opens contexts with withContext only.
 */
export async function setSignedContext(
  tx: TenantTx,
  context: { tenantId?: string | null; userId?: string | null },
): Promise<void> {
  const key = await requestContextKey();
  const [here] = await tx.$queryRaw<{ pid: string; started: string }[]>`
    SELECT pg_backend_pid()::text AS pid,
           (extract(epoch FROM now()) * 1000000)::bigint::text AS started`;
  const value = signRequestContext(key, {
    tenantId: context.tenantId ?? null,
    userId: context.userId ?? null,
    pid: here!.pid,
    startedMicros: here!.started,
  });
  await tx.$executeRaw`SELECT set_config('app.context', ${value}, true)`;
}

export const appClient = (): PrismaClient => createPrismaClient(APP_URL);

/**
 * A valid Bangladeshi mobile number (E.164) that no other test user of this database has, in this
 * run or an earlier one (`test-phones.ts`; the API tests draw from +88013, these from +88014).
 */
export const randomPhone: () => string = phoneSource('+88014', APP_URL);
export const ownerClient = (): PrismaClient => createPrismaClient(OWNER_URL);
/** The API platform module's role: the only one that may run the platform_* functions. */
export const platformClient = (): PrismaClient => createPrismaClient(PLATFORM_URL);
/** The password login's login (P1-J): only auth_find_user_for_password_login. */
export const loginClient = (): PrismaClient => createPrismaClient(LOGIN_URL);
/** The device receiver's login: no table grants, only the ingest_* functions. */
export const ingestClient = (): PrismaClient => createPrismaClient(INGEST_URL);

/**
 * A live platform session of a new admin, made directly as the owner role (the login itself is
 * tested in platform-functions.test.ts). Pass `tokenHash` to withPlatformSession.
 */
export async function newPlatformSession(
  owner: PrismaClient,
): Promise<{ adminId: string; tokenHash: string }> {
  const admin = await owner.platformAdmin.create({
    data: {
      name: 'Platform Tester',
      phone: randomPhone(),
      passwordHash: 'not-a-real-hash',
      totpSecret: 'v1.test',
      totpEnabledAt: new Date(),
    },
  });
  const tokenHash = hashPlatformToken(randomBytes(32).toString('base64url'));
  await owner.platformSession.create({
    data: {
      adminId: admin.id,
      tokenHash,
      idleExpiresAt: new Date(Date.now() + 30 * 60_000),
      expiresAt: new Date(Date.now() + 8 * 3600_000),
    },
  });
  return { adminId: admin.id, tokenHash };
}

/** App-role client with a single pooled connection, to test connection reuse. */
export const singleConnectionAppClient = (): PrismaClient =>
  createPrismaClient(APP_URL, { max: 1 });

/**
 * The test year: the calendar year of today in Asia/Dhaka (`todayIn`; these tests have no clock).
 * Every test institute's current academic year is this year, so tests take their dates from it
 * and never hard-code a year that will pass.
 */
export const testYear = (): number => Number(todayIn('Asia/Dhaka').slice(0, 4));

/** A calendar year as an academic year: named after it, 1 January to 31 December. */
export const yearRange = (year: number) => ({
  name: String(year),
  startDate: new Date(`${year}-01-01`),
  endDate: new Date(`${year}-12-31`),
});

export async function createTenant(
  app: PrismaClient,
  overrides: Partial<ProvisionTenantInput> = {},
): Promise<Tenant> {
  return provisionTenant(app, {
    slug: `t-${randomUUID().slice(0, 8)}`,
    name: 'Test Institute',
    instituteTypeKey: 'NCTB_SCHOOL_BN',
    academicYear: yearRange(testYear()),
    ...overrides,
  });
}

/** Create one student (with an enrolment in the current year) inside the tenant. */
export async function createStudent(app: PrismaClient, tenantId: string, code = 'S-001') {
  return withTenant(app, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const classLevel = await tx.classLevel.findFirstOrThrow({ orderBy: { sortOrder: 'asc' } });
    const student = await tx.student.create({
      data: { tenantId, studentCode: code, nameEn: `Student ${code}` },
    });
    await tx.enrolment.create({
      data: {
        tenantId,
        studentId: student.id,
        academicYearId: year.id,
        classLevelId: classLevel.id,
      },
    });
    return { student, year, classLevel };
  });
}

/** Every table protected by RLS: has a tenant_id column, plus `tenants` itself. */
export async function tenantTableNames(client: PrismaClient): Promise<string[]> {
  const rows = await client.$queryRaw<{ table_name: string }[]>`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND (c.relname = 'tenants' OR EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))
    ORDER BY 1`;
  return rows.map((r) => r.table_name);
}

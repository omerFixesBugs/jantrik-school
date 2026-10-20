import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  createPrismaClient,
  provisionTenant,
  withTenant,
  type ProvisionTenantInput,
  type Tenant,
} from '../src/index.js';
import { APP_URL, OWNER_URL, PLATFORM_URL } from './env.js';

export const appClient = (): PrismaClient => createPrismaClient(APP_URL);

/** A random valid Bangladeshi mobile number (E.164). */
export const randomPhone = (): string =>
  `+88017${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
export const ownerClient = (): PrismaClient => createPrismaClient(OWNER_URL);
/** The API platform module's role: the only one that may run the platform_* functions. */
export const platformClient = (): PrismaClient => createPrismaClient(PLATFORM_URL);

/** App-role client with a single pooled connection, to test connection reuse. */
export const singleConnectionAppClient = (): PrismaClient =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString: APP_URL, max: 1 }) });

export async function createTenant(
  app: PrismaClient,
  overrides: Partial<ProvisionTenantInput> = {},
): Promise<Tenant> {
  return provisionTenant(app, {
    slug: `t-${randomUUID().slice(0, 8)}`,
    name: 'Test Institute',
    instituteTypeKey: 'NCTB_SCHOOL_BN',
    academicYear: {
      name: '2026',
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-12-31'),
    },
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

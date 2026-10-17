import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantClient, withTenant, type PrismaClient } from '../src/index.js';
import {
  appClient,
  createStudent,
  createTenant,
  ownerClient,
  singleConnectionAppClient,
  tenantTableNames,
} from './helpers.js';

async function countRows(client: PrismaClient, table: string): Promise<number> {
  // Table names come from pg_catalog, not user input.
  const [row] = await client.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM "${table}"`,
  );
  return Number(row?.n);
}

describe('RLS: no tenant context means no rows', () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  let tables: string[];
  let tenantId: string;

  beforeAll(async () => {
    app = appClient();
    owner = ownerClient();
    // Make sure there is data in the tenant tables.
    tenantId = (await createTenant(app)).id;
    await createStudent(app, tenantId);
    tables = await tenantTableNames(app);
  });

  afterAll(async () => {
    await Promise.all([app.$disconnect(), owner.$disconnect()]);
  });

  it('the data exists when the context is set', async () => {
    const db = tenantClient(app, tenantId);
    expect(await db.student.count()).toBe(1);
    expect(await db.classLevel.count()).toBeGreaterThan(0);
  });

  it('every tenant table returns nothing to the app role without context', async () => {
    for (const table of tables) {
      expect({ table, rows: await countRows(app, table) }).toEqual({ table, rows: 0 });
    }
  });

  it('Prisma model queries without context return nothing', async () => {
    expect(await app.student.findMany()).toEqual([]);
    expect(await app.tenant.findMany()).toEqual([]);
    expect(await app.gradeBand.count()).toBe(0);
  });

  it('even the table owner sees nothing (FORCE ROW LEVEL SECURITY)', async () => {
    for (const table of tables) {
      expect({ table, rows: await countRows(owner, table) }).toEqual({ table, rows: 0 });
    }
  });

  it('a pooled connection does not leak the previous tenant (SET LOCAL + empty setting)', async () => {
    const single = singleConnectionAppClient();
    try {
      expect(await withTenant(single, tenantId, (tx) => tx.student.count())).toBe(1);

      // Same physical connection: the setting is now '' (not NULL) — must still mean "nothing".
      const [setting] = await single.$queryRaw<{ value: string | null }[]>`
        SELECT current_setting('app.tenant_id', true) AS value`;
      expect(setting?.value).toBe('');
      expect(await single.student.count()).toBe(0);
    } finally {
      await single.$disconnect();
    }
  });

  it('raw queries on a tenantClient are not scoped, so they fail closed', async () => {
    const db = tenantClient(app, tenantId);
    const rows = await db.$queryRaw<{ id: string }[]>`SELECT id FROM students`;
    expect(rows).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

// student_imports: tenant RLS, kept as history (no DELETE), CHECKs.
describe('student_imports', () => {
  let app: PrismaClient;
  let a: string;
  let b: string;
  let importId: string;

  beforeAll(async () => {
    app = appClient();
    a = (await createTenant(app)).id;
    b = (await createTenant(app)).id;
    importId = await withTenant(app, a, async (tx) => {
      const userId = await findOrCreateUser(tx, randomPhone(), 'Admin');
      await tx.membership.create({ data: { tenantId: a, userId, role: 'ADMIN' } });
      const row = await tx.studentImport.create({
        data: {
          tenantId: a,
          createdById: userId,
          fileName: 'students.xlsx',
          headers: ['Name'],
          rows: [['Rafi']],
          rowCount: 1,
        },
      });
      return row.id;
    });
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it("another tenant cannot see or change A's import", async () => {
    await withTenant(app, b, async (tx) => {
      expect(await tx.studentImport.findMany()).toEqual([]);
      expect(
        (await tx.studentImport.updateMany({ where: { id: importId }, data: { rows: [] } })).count,
      ).toBe(0);
    });
  });

  it('cannot be deleted by the app; counters stay in range', async () => {
    await expect(
      withTenant(app, a, (tx) => tx.$executeRaw`DELETE FROM student_imports`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(app, a, (tx) =>
        tx.studentImport.update({ where: { id: importId }, data: { processed: 5 } }),
      ),
    ).rejects.toThrow();
  });

  it('duplicate overrides start empty and are bounded (decision #22)', async () => {
    const row = await withTenant(app, a, (tx) =>
      tx.studentImport.findUniqueOrThrow({ where: { id: importId } }),
    );
    expect(row.duplicateOverrides).toEqual([]);
    await withTenant(app, a, (tx) =>
      tx.studentImport.update({ where: { id: importId }, data: { duplicateOverrides: [2, 5] } }),
    );
    await expect(
      withTenant(app, a, (tx) =>
        tx.studentImport.update({
          where: { id: importId },
          data: { duplicateOverrides: Array.from({ length: 5001 }, (_, i) => i + 2) },
        }),
      ),
    ).rejects.toThrow();
  });
});

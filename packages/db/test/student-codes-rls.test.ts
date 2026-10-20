import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant } from './helpers.js';

// student_settings / student_code_counters: tenant RLS, no DELETE grant, CHECKs.
describe('student code tables', () => {
  let app: PrismaClient;
  let a: string;
  let b: string;

  beforeAll(async () => {
    app = appClient();
    a = (await createTenant(app)).id;
    b = (await createTenant(app)).id;
    await withTenant(app, a, async (tx) => {
      await tx.studentSettings.create({ data: { tenantId: a, codePrefix: 'AAA' } });
      await tx.studentCodeCounter.create({ data: { tenantId: a, year: 2026, nextValue: 5 } });
    });
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it("another tenant cannot read, change or write A's rows", async () => {
    await withTenant(app, b, async (tx) => {
      expect(await tx.studentSettings.findMany()).toEqual([]);
      expect(await tx.studentCodeCounter.findMany()).toEqual([]);
      expect((await tx.studentCodeCounter.updateMany({ data: { nextValue: 1 } })).count).toBe(0);
    });
    await expect(
      withTenant(app, b, (tx) =>
        tx.studentCodeCounter.create({ data: { tenantId: a, year: 2027, nextValue: 1 } }),
      ),
    ).rejects.toThrow();
    const counter = await withTenant(app, a, (tx) =>
      tx.studentCodeCounter.findFirstOrThrow({ where: { year: 2026 } }),
    );
    expect(counter.nextValue).toBe(5);
  });

  it('rows are never deleted by the app; CHECKs hold', async () => {
    await expect(
      withTenant(app, a, (tx) => tx.$executeRaw`DELETE FROM student_code_counters`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(app, b, (tx) =>
        tx.studentSettings.create({ data: { tenantId: b, codePrefix: 'bad prefix' } }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(app, b, (tx) =>
        tx.studentCodeCounter.create({ data: { tenantId: b, year: 2026, nextValue: 0 } }),
      ),
    ).rejects.toThrow();
  });
});

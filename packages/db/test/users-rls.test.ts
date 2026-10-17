import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withContext, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

async function addMember(app: PrismaClient, tenantId: string, phone: string, name: string) {
  return withTenant(app, tenantId, async (tx) => {
    const userId = await findOrCreateUser(tx, phone, name);
    await tx.membership.create({ data: { tenantId, userId, role: 'TEACHER' } });
    return userId;
  });
}

describe('RLS on users', () => {
  let app: PrismaClient;
  let tenantA: string;
  let tenantB: string;
  let userA: string; // member of A only
  let userB: string; // member of B only
  let shared: string; // member of A and B

  beforeAll(async () => {
    app = appClient();
    tenantA = (await createTenant(app)).id;
    tenantB = (await createTenant(app)).id;
    userA = await addMember(app, tenantA, randomPhone(), 'Only A');
    userB = await addMember(app, tenantB, randomPhone(), 'Only B');
    const sharedPhone = randomPhone();
    shared = await addMember(app, tenantA, sharedPhone, 'Shared');
    expect(await addMember(app, tenantB, sharedPhone, 'Shared')).toBe(shared);
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it('tenant A context cannot read users who only belong to tenant B', async () => {
    const ids = await withTenant(app, tenantA, async (tx) =>
      (await tx.user.findMany({ select: { id: true } })).map((u) => u.id),
    );
    expect(ids).toEqual(expect.arrayContaining([userA, shared]));
    expect(ids).not.toContain(userB);
    expect(
      await withTenant(app, tenantA, (tx) => tx.user.findUnique({ where: { id: userB } })),
    ).toBeNull();
  });

  it('a user context alone sees only that user', async () => {
    const users = await withContext(app, { userId: userB }, (tx) => tx.user.findMany());
    expect(users.map((u) => u.id)).toEqual([userB]);
  });

  it('no context sees no users', async () => {
    expect(await app.user.count()).toBe(0);
  });

  it('a user can update only their own row, even inside their tenant', async () => {
    await withContext(app, { tenantId: tenantA, userId: userA }, async (tx) => {
      const other = await tx.user.updateMany({ where: { id: shared }, data: { name: 'x' } });
      expect(other.count).toBe(0);
      const self = await tx.user.updateMany({ where: { id: userA }, data: { locale: 'en' } });
      expect(self.count).toBe(1);
    });
  });

  it('the app role cannot insert or delete users directly', async () => {
    await expect(
      withTenant(
        app,
        tenantA,
        (tx) =>
          tx.$executeRaw`INSERT INTO users (id, phone, name) VALUES (gen_random_uuid(), ${randomPhone()}, 'x')`,
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withContext(app, { userId: userA }, (tx) => tx.$executeRaw`DELETE FROM users`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('findOrCreateUser requires a tenant context', async () => {
    await expect(
      withContext(app, { userId: userA }, (tx) => findOrCreateUser(tx, randomPhone(), 'x')),
    ).rejects.toThrow(/requires a tenant context/);
  });

  it('findOrCreateUser does not expose a person from another tenant before membership', async () => {
    const phoneOfB = await withContext(
      app,
      { userId: userB },
      async (tx) => (await tx.user.findUniqueOrThrow({ where: { id: userB } })).phone,
    );
    await withTenant(app, tenantA, async (tx) => {
      expect(await findOrCreateUser(tx, phoneOfB, 'Someone else')).toBe(userB);
      expect(await tx.user.findUnique({ where: { id: userB } })).toBeNull();
    });
  });
});

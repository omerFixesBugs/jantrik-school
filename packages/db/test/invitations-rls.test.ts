import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withContext, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

// Staff invitations: an invited/declined person's global row stays hidden from the institute.
describe('invitations and staff_profiles', () => {
  let app: PrismaClient;
  let a: string;
  let b: string;
  let userId: string;

  beforeAll(async () => {
    app = appClient();
    a = (await createTenant(app)).id;
    b = (await createTenant(app)).id;
    // The person exists in B (with their own global name), then A invites them.
    userId = await withTenant(app, b, async (tx) => {
      const id = await findOrCreateUser(tx, randomPhone(), 'Global Name');
      await tx.membership.create({ data: { tenantId: b, userId: id, role: 'TEACHER' } });
      return id;
    });
    await withTenant(app, a, async (tx) => {
      await tx.membership.create({
        data: { tenantId: a, userId, role: 'TEACHER', status: 'INVITED', invitedAt: new Date() },
      });
      await tx.staffProfile.create({
        data: { tenantId: a, userId, name: 'Typed Name', phone: '+8801711999999' },
      });
    });
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  const seenByA = () => withTenant(app, a, (tx) => tx.user.findUnique({ where: { id: userId } }));

  it('INVITED or DECLINED: the user row is invisible to the inviting tenant', async () => {
    expect(await seenByA()).toBeNull();
    await withTenant(app, a, (tx) =>
      tx.membership.updateMany({ where: { userId }, data: { status: 'DECLINED' } }),
    );
    expect(await seenByA()).toBeNull();
  });

  it('ACTIVE (accepted) or DISABLED: visible again', async () => {
    await withTenant(app, a, (tx) =>
      tx.membership.updateMany({ where: { userId }, data: { status: 'ACTIVE' } }),
    );
    expect((await seenByA())?.name).toBe('Global Name');
    await withTenant(app, a, (tx) =>
      tx.membership.updateMany({ where: { userId }, data: { status: 'DISABLED' } }),
    );
    expect(await seenByA()).not.toBeNull();
  });

  it('staff_profiles: tenant isolation, no DELETE, phone format', async () => {
    await withTenant(app, b, async (tx) => {
      expect(await tx.staffProfile.findMany()).toEqual([]);
    });
    await expect(
      withTenant(app, a, (tx) => tx.$executeRaw`DELETE FROM staff_profiles`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(app, b, (tx) =>
        tx.staffProfile.create({ data: { tenantId: b, userId, name: 'x', phone: '123' } }),
      ),
    ).rejects.toThrow();
  });

  it('auth_list_my_memberships returns invited_at for the person themselves', async () => {
    await withTenant(app, a, (tx) =>
      tx.membership.updateMany({
        where: { userId },
        data: { status: 'INVITED', invitedAt: new Date('2026-10-01T00:00:00Z') },
      }),
    );
    const rows = await withContext(
      app,
      { userId },
      (tx) =>
        tx.$queryRaw<{ tenant_id: string; membership_status: string; invited_at: Date | null }[]>`
        SELECT tenant_id::text, membership_status::text, invited_at FROM auth_list_my_memberships()`,
    );
    const inA = rows.find((r) => r.tenant_id === a)!;
    expect(inA.membership_status).toBe('INVITED');
    expect(inA.invited_at?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

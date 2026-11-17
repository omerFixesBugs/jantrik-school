import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

// SMS broadcasts (sprint 1 P6b): forced RLS on sms_broadcasts and sms_broadcast_targets, no
// DELETE on broadcasts (money history), created_by not changeable, the CHECKs, the BROADCAST
// SMS purpose.
describe('broadcasts RLS', () => {
  let app: PrismaClient;
  let a: string;
  let b: string;
  let userA: string;
  let classA: string;
  let classB: string;
  let broadcastA: string;

  const newUser = (tenantId: string) =>
    withTenant(app, tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT app_find_or_create_user(${randomPhone()}, 'Broadcast Tester', NULL)::text AS id`;
      await tx.membership.create({ data: { tenantId, userId: row!.id, role: 'ADMIN' } });
      return row!.id;
    });

  beforeAll(async () => {
    app = appClient();
    a = (await createTenant(app)).id;
    b = (await createTenant(app)).id;
    userA = await newUser(a);
    classA = (await withTenant(app, a, (tx) => tx.classLevel.findFirstOrThrow())).id;
    classB = (await withTenant(app, b, (tx) => tx.classLevel.findFirstOrThrow())).id;
    broadcastA = await withTenant(app, a, async (tx) => {
      const row = await tx.smsBroadcast.create({
        data: {
          tenantId: a,
          body: 'Holiday tomorrow',
          recipients: 'PRIMARY_GUARDIANS',
          createdById: userA,
        },
      });
      await tx.smsBroadcastTarget.create({
        data: { tenantId: a, broadcastId: row.id, classLevelId: classA },
      });
      return row.id;
    });
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it("another institute sees and changes none of A's broadcasts or targets", async () => {
    await withTenant(app, b, async (tx) => {
      expect(await tx.smsBroadcast.findMany()).toEqual([]);
      expect(await tx.smsBroadcastTarget.findMany()).toEqual([]);
      expect((await tx.smsBroadcast.updateMany({ data: { body: 'x' } })).count).toBe(0);
    });
    await expect(
      withTenant(app, a, (tx) =>
        tx.smsBroadcastTarget.create({
          data: { tenantId: a, broadcastId: broadcastA, classLevelId: classB },
        }),
      ),
    ).rejects.toThrow();
  });

  it('never deleted; created_by not changed; targets deletable', async () => {
    await expect(
      withTenant(app, a, (tx) => tx.$executeRaw`DELETE FROM sms_broadcasts`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(app, a, (tx) => tx.$executeRaw`UPDATE sms_broadcasts SET created_by_id = created_by_id`),
    ).rejects.toThrow(/permission denied/);
    await withTenant(app, a, (tx) => tx.smsBroadcastTarget.deleteMany({ where: { broadcastId: broadcastA } }));
  });

  it('the CHECKs', async () => {
    const base = { tenantId: a, recipients: 'STAFF' as const, createdById: userA };
    const at = new Date();
    const bad = [
      { ...base, body: '' },
      { ...base, body: 'x'.repeat(481) },
      { ...base, body: 'x', status: 'SCHEDULED' as const }, // no scheduled_at / who
      { ...base, body: 'x', status: 'SENT' as const, scheduledAt: at, scheduledById: userA },
      { ...base, body: 'x', status: 'CANCELLED' as const },
      { ...base, body: 'x', status: 'CANCELLED' as const, cancelledAt: at, cancelReason: 'OOPS' },
      { ...base, body: 'x', status: 'FAILED_OVER_CAP' as const, scheduledAt: at, scheduledById: userA },
      { ...base, body: 'x', segments: 0 },
      { ...base, body: 'x', segments: 4 },
      { ...base, body: 'x', queuedCount: -1 },
    ];
    for (const data of bad) {
      await expect(withTenant(app, a, (tx) => tx.smsBroadcast.create({ data }))).rejects.toThrow();
    }
    await withTenant(app, a, (tx) =>
      tx.smsBroadcast.create({
        data: {
          ...base,
          body: 'x'.repeat(480),
          status: 'SENT',
          scheduledAt: at,
          scheduledById: userA,
          sentAt: at,
          queuedCount: 0,
          localDate: new Date('2026-11-17'),
          segments: 3,
        },
      }),
    );
  });

  it('the BROADCAST SMS purpose exists', async () => {
    const rows = await app.$queryRaw<{ v: string }[]>`
      SELECT unnest(enum_range(NULL::sms_purpose))::text AS v`;
    expect(rows.map((r) => r.v)).toContain('BROADCAST');
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext, withTenant, type PrismaClient, type TenantTx } from '../src/index.js';
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
      withTenant(
        app,
        a,
        (tx) => tx.$executeRaw`UPDATE sms_broadcasts SET created_by_id = created_by_id`,
      ),
    ).rejects.toThrow(/permission denied/);
    await withTenant(app, a, (tx) =>
      tx.smsBroadcastTarget.deleteMany({ where: { broadcastId: broadcastA } }),
    );
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
      {
        ...base,
        body: 'x',
        status: 'FAILED_OVER_CAP' as const,
        scheduledAt: at,
        scheduledById: userA,
      },
      { ...base, body: 'x', status: 'EXPIRED' as const, scheduledAt: at, scheduledById: userA }, // no failure
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

  it("cannot make the send job act as a colleague (sms_broadcasts.scheduled_by_id, P6-b21)", async () => {
    // The send job signs its context as the broadcast's scheduler, read from this column (and
    // checks that person's roles), so the app login must not be able to put anyone else there.
    const colleague = await newUser(a);
    const asA = <T>(fn: (tx: TenantTx) => Promise<T>) =>
      withContext(app, { tenantId: a, userId: userA }, fn);
    const asColleague = <T>(fn: (tx: TenantTx) => Promise<T>) =>
      withContext(app, { tenantId: a, userId: colleague }, fn);
    const at = new Date(Date.now() + 3_600_000);
    const { id } = await asA((tx) =>
      tx.smsBroadcast.create({
        data: { tenantId: a, body: 'Sports day', recipients: 'STAFF', createdById: userA },
        select: { id: true },
      }),
    );
    // An injection in A's request: schedule A's draft in the colleague's name...
    await expect(
      asA(
        (tx) => tx.$executeRaw`UPDATE sms_broadcasts
          SET status = 'SCHEDULED', scheduled_at = ${at}, scheduled_by_id = ${colleague}::uuid
          WHERE id = ${id}::uuid`,
      ),
    ).rejects.toThrow(/scheduled by the signed-in person only/);
    // ...or insert a scheduled broadcast that names them.
    await expect(
      asA(
        (tx) => tx.$executeRaw`INSERT INTO sms_broadcasts (id, tenant_id, body, recipients,
            created_by_id, status, scheduled_at, scheduled_by_id, updated_at)
          VALUES (${randomUUID()}::uuid, ${a}::uuid, 'x', 'STAFF', ${userA}::uuid, 'SCHEDULED',
            ${at}, ${colleague}::uuid, now())`,
      ),
    ).rejects.toThrow(/scheduled by the signed-in person only/);

    // The app's own writes still work. A schedules it as A.
    await asA((tx) =>
      tx.smsBroadcast.update({
        where: { id },
        data: { status: 'SCHEDULED', scheduledAt: at, scheduledById: userA },
      }),
    );
    // Another admin may write the row as long as the scheduler stays as it is...
    await asColleague(
      (tx) => tx.$executeRaw`UPDATE sms_broadcasts SET scheduled_by_id = scheduled_by_id`,
    );
    // ...or edit it back to a draft, which clears the scheduler...
    await expect(
      asColleague(
        (tx) => tx.$executeRaw`UPDATE sms_broadcasts SET scheduled_by_id = NULL, status = 'DRAFT',
          scheduled_at = NULL WHERE id = ${id}::uuid`,
      ),
    ).resolves.toBe(1);
    await expect(
      asColleague(
        (tx) => tx.$executeRaw`UPDATE sms_broadcasts
          SET status = 'SCHEDULED', scheduled_at = ${at}, scheduled_by_id = ${userA}::uuid
          WHERE id = ${id}::uuid`,
      ),
    ).rejects.toThrow(/scheduled by the signed-in person only/);
    // ...and schedule it as themselves, never in A's name.
    await asColleague((tx) =>
      tx.smsBroadcast.update({
        where: { id },
        data: { status: 'SCHEDULED', scheduledAt: at, scheduledById: colleague },
      }),
    );
    expect(
      await withTenant(app, a, (tx) =>
        tx.smsBroadcast.findUniqueOrThrow({ where: { id }, select: { scheduledById: true } }),
      ),
    ).toEqual({ scheduledById: colleague });
  });

  it('the BROADCAST SMS purpose exists', async () => {
    const rows = await app.$queryRaw<{ v: string }[]>`
      SELECT unnest(enum_range(NULL::sms_purpose))::text AS v`;
    expect(rows.map((r) => r.v)).toContain('BROADCAST');
  });
});

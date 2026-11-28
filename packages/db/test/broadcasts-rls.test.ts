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

  // P6-b21: the send job signs its context as the broadcast's scheduler (`scheduled_by_id`) and
  // checks that person's roles, then sends what the row says. So a request (an SQL injection rides
  // in one, as its signed person) must never leave a SCHEDULED row in another person's name, by
  // naming them or by changing or bringing back a broadcast they scheduled.
  describe('the send job acts only as the person who scheduled it (P6-b21)', () => {
    let colleague: string;
    const at = () => new Date(Date.now() + 3_600_000);
    const asA = <T>(fn: (tx: TenantTx) => Promise<T>) =>
      withContext(app, { tenantId: a, userId: userA }, fn);
    const asColleague = <T>(fn: (tx: TenantTx) => Promise<T>) =>
      withContext(app, { tenantId: a, userId: colleague }, fn);
    const refused = /scheduled by the signed-in person only/;
    const draftOfA = async () =>
      (
        await asA((tx) =>
          tx.smsBroadcast.create({
            data: {
              tenantId: a,
              body: 'Sports day',
              recipients: 'PRIMARY_GUARDIANS',
              createdById: userA,
            },
            select: { id: true },
          }),
        )
      ).id;
    /** A's broadcast, scheduled by A (as the app does it), with one class targeted. */
    const scheduledByA = async () => {
      const id = await draftOfA();
      await asA(async (tx) => {
        await tx.smsBroadcastTarget.create({
          data: { tenantId: a, broadcastId: id, classLevelId: classA },
        });
        await tx.smsBroadcast.update({
          where: { id },
          data: { status: 'SCHEDULED', scheduledAt: at(), scheduledById: userA },
        });
      });
      return id;
    };
    const row = (id: string) =>
      withTenant(app, a, (tx) =>
        tx.smsBroadcast.findUniqueOrThrow({
          where: { id },
          select: { status: true, body: true, scheduledById: true },
        }),
      );

    beforeAll(async () => {
      colleague = await newUser(a);
    });

    it('a request cannot name someone else as the scheduler', async () => {
      const id = await draftOfA();
      await expect(
        asA(
          (tx) => tx.$executeRaw`UPDATE sms_broadcasts
            SET status = 'SCHEDULED', scheduled_at = ${at()}, scheduled_by_id = ${colleague}::uuid
            WHERE id = ${id}::uuid`,
        ),
      ).rejects.toThrow(refused);
      await expect(
        asA(
          (tx) => tx.$executeRaw`INSERT INTO sms_broadcasts (id, tenant_id, body, recipients,
              created_by_id, status, scheduled_at, scheduled_by_id, updated_at)
            VALUES (${randomUUID()}::uuid, ${a}::uuid, 'x', 'STAFF', ${userA}::uuid, 'SCHEDULED',
              ${at()}, ${colleague}::uuid, now())`,
        ),
      ).rejects.toThrow(refused);
      // A row that is not scheduled cannot carry someone else's name either.
      await expect(
        asA(
          (tx) => tx.$executeRaw`UPDATE sms_broadcasts SET scheduled_by_id = ${colleague}::uuid
            WHERE id = ${id}::uuid`,
        ),
      ).rejects.toThrow(refused);
      expect(await row(id)).toMatchObject({ status: 'DRAFT', scheduledById: null });
    });

    it('a request cannot change, retarget or bring back a broadcast another person scheduled', async () => {
      const id = await scheduledByA();
      // Changing what A's scheduled broadcast says, or whom it goes to, without touching the column.
      await expect(
        asColleague(
          (
            tx,
          ) => tx.$executeRaw`UPDATE sms_broadcasts SET body = 'Injected', recipients = 'ALL_GUARDIANS',
            estimated_cost_paisa = 100000000 WHERE id = ${id}::uuid`,
        ),
      ).rejects.toThrow(refused);
      await expect(
        asColleague((tx) =>
          tx.smsBroadcastTarget.create({
            data: { tenantId: a, broadcastId: id, classLevelId: classA },
          }),
        ),
      ).rejects.toThrow(refused);
      await expect(
        asColleague(
          (tx) =>
            tx.$executeRaw`DELETE FROM sms_broadcast_targets WHERE broadcast_id = ${id}::uuid`,
        ),
      ).rejects.toThrow(refused);
      expect(await row(id)).toMatchObject({ status: 'SCHEDULED', body: 'Sports day' });

      // Cancelled (an app path), then brought back to SCHEDULED, in A's name, by an UPDATE...
      await asColleague((tx) =>
        tx.smsBroadcast.update({
          where: { id },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledById: colleague,
            cancelReason: 'BY_ADMIN',
          },
        }),
      );
      await expect(
        asColleague(
          (tx) => tx.$executeRaw`UPDATE sms_broadcasts SET status = 'SCHEDULED', body = 'Injected',
            scheduled_at = now() - interval '3 minutes', cancelled_at = NULL, cancel_reason = NULL,
            cancelled_by_id = NULL WHERE id = ${id}::uuid`,
        ),
      ).rejects.toThrow(refused);
      // ...or by an INSERT ... ON CONFLICT DO UPDATE.
      await expect(
        asColleague(
          (tx) => tx.$executeRaw`INSERT INTO sms_broadcasts (id, tenant_id, body, recipients,
              created_by_id, updated_at)
            VALUES (${id}::uuid, ${a}::uuid, 'x', 'STAFF', ${colleague}::uuid, now())
            ON CONFLICT (id) DO UPDATE SET status = 'SCHEDULED', body = 'Injected',
              scheduled_at = now(), cancelled_at = NULL, cancel_reason = NULL`,
        ),
      ).rejects.toThrow(refused);
      expect(await row(id)).toMatchObject({ status: 'CANCELLED', body: 'Sports day' });
    });

    it("the app's own writes still work: scheduling, cancelling, editing back to a draft", async () => {
      // Another admin cancels A's scheduled broadcast.
      const cancelled = await scheduledByA();
      await asColleague((tx) =>
        tx.smsBroadcast.update({
          where: { id: cancelled },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledById: colleague,
            cancelReason: 'BY_ADMIN',
          },
        }),
      );
      // Another admin edits A's scheduled broadcast: back to a draft first (the service does it in
      // this order), then the new targets, then schedules it as themselves, never in A's name.
      const edited = await scheduledByA();
      await asColleague(async (tx) => {
        await tx.smsBroadcast.update({
          where: { id: edited },
          data: {
            body: 'Sports day moved',
            status: 'DRAFT',
            scheduledAt: null,
            scheduledById: null,
            previewCount: null,
            segments: null,
            estimatedCostPaisa: null,
          },
        });
        await tx.smsBroadcastTarget.deleteMany({ where: { broadcastId: edited } });
        await tx.smsBroadcastTarget.create({
          data: { tenantId: a, broadcastId: edited, classLevelId: classA },
        });
      });
      await expect(
        asColleague((tx) =>
          tx.smsBroadcast.update({
            where: { id: edited },
            data: { status: 'SCHEDULED', scheduledAt: at(), scheduledById: userA },
          }),
        ),
      ).rejects.toThrow(refused);
      await asColleague((tx) =>
        tx.smsBroadcast.update({
          where: { id: edited },
          data: { status: 'SCHEDULED', scheduledAt: at(), scheduledById: colleague },
        }),
      );
      expect(await row(edited)).toMatchObject({
        status: 'SCHEDULED',
        body: 'Sports day moved',
        scheduledById: colleague,
      });
    });

    it('the send job (signed as the scheduler) and the worker (no person) still write their outcomes', async () => {
      const now = new Date();
      const failure = { confirmedCostPaisa: 1, costPaisa: 2, recipients: 1 };
      const outcomes = [
        { status: 'SENT', sentAt: now, queuedCount: 1, localDate: now },
        { status: 'EXPIRED', failure },
        { status: 'COST_CHANGED', failure },
        { status: 'FAILED_OVER_CAP', failure },
        { status: 'CANCELLED', cancelledAt: now, cancelReason: 'ACTOR_NOT_ADMIN' },
      ] as const;
      for (const data of outcomes) {
        const id = await scheduledByA();
        await asA((tx) => tx.smsBroadcast.update({ where: { id }, data }));
        expect((await row(id)).status).toBe(data.status);
      }
      // The worker's own context has an institute and no person: not checked (as P1-J8k).
      const id = await scheduledByA();
      await withTenant(app, a, (tx) =>
        tx.smsBroadcast.update({ where: { id }, data: { status: 'EXPIRED', failure } }),
      );
      expect((await row(id)).status).toBe('EXPIRED');
    });

    // Review round 2: the targets check read the parent without a lock, so a colleague's insert
    // or delete racing A's scheduling transaction (which holds the row FOR UPDATE, as the service
    // does) went through, and A's SCHEDULED broadcast went to an audience A never previewed (no
    // targets at all = the whole school). Two connections, the colleague signed as themselves.
    it("a colleague's target change racing A's scheduling waits for it, then is refused", async () => {
      const targets = (id: string) =>
        withTenant(app, a, (tx) => tx.smsBroadcastTarget.count({ where: { broadcastId: id } }));
      for (const attack of ['delete', 'insert'] as const) {
        const id = await draftOfA();
        await asA((tx) =>
          tx.smsBroadcastTarget.create({
            data: { tenantId: a, broadcastId: id, classLevelId: classA },
          }),
        );
        let locked!: () => void;
        let release!: () => void;
        const isLocked = new Promise<void>((r) => (locked = r));
        const released = new Promise<void>((r) => (release = r));
        const scheduling = asA(async (tx) => {
          await tx.$queryRaw`SELECT id FROM sms_broadcasts WHERE id = ${id}::uuid FOR UPDATE`;
          await tx.smsBroadcast.update({
            where: { id },
            data: { status: 'SCHEDULED', scheduledAt: at(), scheduledById: userA },
          });
          locked();
          await released;
        });
        await isLocked;
        const change = asColleague((tx) =>
          attack === 'delete'
            ? tx.$executeRaw`DELETE FROM sms_broadcast_targets WHERE broadcast_id = ${id}::uuid`
            : tx.$executeRaw`INSERT INTO sms_broadcast_targets (id, tenant_id, broadcast_id,
                  class_level_id, updated_at)
                VALUES (${randomUUID()}::uuid, ${a}::uuid, ${id}::uuid, ${classA}::uuid, now())`,
        ).then(
          () => 'went through',
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        );
        // The colleague's statement is sent while A still holds the row, then A commits.
        await new Promise((r) => setTimeout(r, 300));
        release();
        await scheduling;
        expect(await change).toMatch(refused);
        expect(await targets(id)).toBe(1);
        expect(await row(id)).toMatchObject({ status: 'SCHEDULED', scheduledById: userA });
      }
    });
  });

  it('the BROADCAST SMS purpose exists', async () => {
    const rows = await app.$queryRaw<{ v: string }[]>`
      SELECT unnest(enum_range(NULL::sms_purpose))::text AS v`;
    expect(rows.map((r) => r.v)).toContain('BROADCAST');
  });
});

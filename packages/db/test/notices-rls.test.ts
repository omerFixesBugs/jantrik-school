import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

// Notices (sprint 1 P6a): forced RLS on notices, notice_targets, notice_reads; reads only for
// oneself; no DELETE on notices, no UPDATE/DELETE on reads; targets of another institute's class
// or a section of another class refused by the composite keys; the CHECKs.
describe('notices RLS', () => {
  let app: PrismaClient;
  let a: string;
  let b: string;
  let userA: string;
  let userB: string;
  let classA: string;
  let classA2: string;
  let sectionA2: string;
  let classB: string;
  let noticeA: string;

  const newUser = (tenantId: string) =>
    withTenant(app, tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT app_find_or_create_user(${randomPhone()}, 'Notice Tester', NULL)::text AS id`;
      await tx.membership.create({ data: { tenantId, userId: row!.id, role: 'ADMIN' } });
      return row!.id;
    });

  beforeAll(async () => {
    app = appClient();
    a = (await createTenant(app)).id;
    b = (await createTenant(app)).id;
    userA = await newUser(a);
    userB = await newUser(b);
    ({ classA, classA2, sectionA2 } = await withTenant(app, a, async (tx) => {
      const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
      const [c1, c2] = await tx.classLevel.findMany({ orderBy: { sortOrder: 'asc' }, take: 2 });
      const s = await tx.section.create({
        data: { tenantId: a, academicYearId: year.id, classLevelId: c2!.id, name: 'ক' },
      });
      return { classA: c1!.id, classA2: c2!.id, sectionA2: s.id };
    }));
    classB = (await withTenant(app, b, (tx) => tx.classLevel.findFirstOrThrow())).id;
    noticeA = (
      await withTenant(app, a, (tx) =>
        tx.notice.create({
          data: {
            tenantId: a,
            title: 'Holiday',
            body: 'School is closed tomorrow.',
            audience: 'ALL',
            createdById: userA,
            targets: { create: [{ tenantId: a, classLevelId: classA }] },
          },
        }),
      )
    ).id;
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it("another institute sees, changes and reads none of A's notices", async () => {
    await withTenant(app, b, async (tx) => {
      expect(await tx.notice.findMany()).toEqual([]);
      expect(await tx.noticeTarget.findMany()).toEqual([]);
      expect((await tx.notice.updateMany({ data: { pinned: true } })).count).toBe(0);
    });
    // A row for institute A written while in B: refused by the policy.
    await expect(
      withTenant(app, b, (tx) =>
        tx.notice.create({
          data: { tenantId: a, title: 'x', body: 'y', audience: 'ALL', createdById: userB },
        }),
      ),
    ).rejects.toThrow();
    // A read of A's notice from B: the notice is not visible, so the composite key fails.
    await expect(
      withContext(app, { tenantId: b, userId: userB }, (tx) =>
        tx.noticeRead.create({ data: { tenantId: b, noticeId: noticeA, userId: userB } }),
      ),
    ).rejects.toThrow();
  });

  it("a target must be one of the institute's classes, and a section of that class", async () => {
    await expect(
      withTenant(app, a, (tx) =>
        tx.noticeTarget.create({ data: { tenantId: a, noticeId: noticeA, classLevelId: classB } }),
      ),
    ).rejects.toThrow();
    // Section ক belongs to the second class, not the first.
    await expect(
      withTenant(app, a, (tx) =>
        tx.noticeTarget.create({
          data: { tenantId: a, noticeId: noticeA, classLevelId: classA, sectionId: sectionA2 },
        }),
      ),
    ).rejects.toThrow();
    const ok = await withTenant(app, a, (tx) =>
      tx.noticeTarget.create({
        data: { tenantId: a, noticeId: noticeA, classLevelId: classA2, sectionId: sectionA2 },
      }),
    );
    // Targets are replaced whole: DELETE is allowed.
    await withTenant(app, a, (tx) => tx.noticeTarget.delete({ where: { id: ok.id } }));
  });

  it('a read is only for oneself, kept once, never changed or deleted', async () => {
    const other = await newUser(a);
    await expect(
      withContext(app, { tenantId: a, userId: userA }, (tx) =>
        tx.noticeRead.create({ data: { tenantId: a, noticeId: noticeA, userId: other } }),
      ),
    ).rejects.toThrow(/row-level security/);
    for (let i = 0; i < 2; i++) {
      await withContext(app, { tenantId: a, userId: userA }, (tx) =>
        tx.noticeRead.createMany({
          data: [{ tenantId: a, noticeId: noticeA, userId: userA }],
          skipDuplicates: true,
        }),
      );
    }
    expect(await withTenant(app, a, (tx) => tx.noticeRead.count())).toBe(1);
    await expect(
      withContext(app, { tenantId: a, userId: userA }, (tx) =>
        tx.$executeRaw`UPDATE notice_reads SET read_at = now()`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withContext(app, { tenantId: a, userId: userA }, (tx) =>
        tx.$executeRaw`DELETE FROM notice_reads`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('notices are never deleted; created_by is not changed', async () => {
    await expect(
      withTenant(app, a, (tx) => tx.$executeRaw`DELETE FROM notices`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(app, a, (tx) => tx.$executeRaw`UPDATE notices SET created_by_id = created_by_id`),
    ).rejects.toThrow(/permission denied/);
  });

  it('the CHECKs', async () => {
    const base = { tenantId: a, body: 'b', audience: 'ALL' as const, createdById: userA };
    const bad = [
      { ...base, title: 'x'.repeat(151) },
      { ...base, title: '   ' },
      { ...base, title: 't', body: 'x'.repeat(5001) },
      { ...base, title: 't', status: 'PUBLISHED' as const }, // no publish_at / who
      { ...base, title: 't', status: 'WITHDRAWN' as const }, // no withdrawn_at / who
      {
        ...base,
        title: 't',
        publishAt: new Date('2026-11-10'),
        expiresAt: new Date('2026-11-09'),
      },
      { ...base, title: 't', withdrawnReason: 'x'.repeat(301) },
    ];
    for (const data of bad) {
      await expect(withTenant(app, a, (tx) => tx.notice.create({ data }))).rejects.toThrow();
    }
    await withTenant(app, a, (tx) =>
      tx.notice.create({
        data: {
          ...base,
          title: 'x'.repeat(150),
          body: 'x'.repeat(5000),
          status: 'PUBLISHED',
          publishAt: new Date(),
          publishedById: userA,
        },
      }),
    );
  });
});

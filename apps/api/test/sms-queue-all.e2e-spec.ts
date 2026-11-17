import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import { todayIn } from '@jantrik/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantSmsService, type QueueTenantSmsInput } from '../src/sms/tenant-sms.service.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import {
  addMember,
  createHarness,
  createTenant,
  randomPhone,
  type Harness,
} from './support/harness.js';

type BatchInput = Omit<QueueTenantSmsInput, 'dailyCap' | 'overCap' | 'localDate' | 'delayMs'>;

// TenantSmsService.queueAll (sprint 1 P6b, S18): a batch queued whole or not at all under the
// institute's SMS lock; duplicates skipped; nothing stored over the cap or on a rollback. The SMS
// use ATTENDANCE_ENTRY, whose relevance check always passes: the test worker sends them (still
// counted), where another purpose's check could cancel them and free room under the cap.
describe('queueAll: all or nothing over the daily cap', () => {
  let h: Harness;
  let tenantId: string;
  let actorUserId: string;
  const today = todayIn('Asia/Dhaka');
  const batch = (n: number, tag = randomUUID()): BatchInput[] =>
    Array.from({ length: n }, (_, i) => ({
      purpose: 'ATTENDANCE_ENTRY' as const,
      phone: randomPhone(),
      body: 'test',
      dedupeKey: `qa:${tag}:${i}`,
    }));
  const run = <T>(fn: () => Promise<T>) =>
    h.app.get(TenantJobRunner).run(tenantId, fn, { actorUserId });
  const queueAll = (inputs: BatchInput[], dailyCap: number) =>
    run(() => h.app.get(TenantSmsService).queueAll(inputs, { dailyCap, localDate: today }));
  const rows = (prefix: string) =>
    withTenant(h.prisma, tenantId, (tx) =>
      tx.smsLog.count({ where: { dedupeKey: { startsWith: prefix } } }),
    );

  beforeAll(async () => {
    h = await createHarness();
    tenantId = (await createTenant(h)).id;
    actorUserId = (await addMember(h, tenantId, { roles: ['ADMIN'] })).userId;
  });
  afterAll(() => h.close());

  it('cap 10 with 4 used: 6 fit, 7 do not (zero rows), and known keys do not count', async () => {
    const seven = batch(7, 'seven');
    // 4 used, two of them already the first two of the seven (as if sent before).
    await expect(queueAll([...batch(2, 'used'), ...seven.slice(0, 2)], 10)).resolves.toEqual({
      outcome: 'QUEUED',
      queued: 4,
      duplicates: 0,
    });
    await expect(queueAll(batch(7, 'over'), 10)).resolves.toEqual({
      outcome: 'OVER_CAP',
      needed: 7,
      capLeft: 6,
    });
    expect(await rows('qa:over:')).toBe(0);
    // The seven again: their two known keys do not count, so the other five fit.
    await expect(queueAll(seven, 10)).resolves.toEqual({
      outcome: 'QUEUED',
      queued: 5,
      duplicates: 2,
    });
    expect(await rows('qa:seven:')).toBe(7);
    // 9 used: exactly one more fits, then nothing; an empty batch is fine.
    await expect(queueAll(batch(1), 10)).resolves.toMatchObject({ outcome: 'QUEUED', queued: 1 });
    await expect(queueAll(batch(1), 10)).resolves.toEqual({
      outcome: 'OVER_CAP',
      needed: 1,
      capLeft: 0,
    });
    await expect(queueAll([], 10)).resolves.toEqual({
      outcome: 'QUEUED',
      queued: 0,
      duplicates: 0,
    });
  });

  it('rolled back with its transaction: no rows and no jobs', async () => {
    const tag = randomUUID();
    await expect(
      run(async () => {
        await h.app
          .get(TenantSmsService)
          .queueAll(batch(3, tag), { dailyCap: 1000, localDate: today });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await rows(`qa:${tag}:`)).toBe(0);
  });

  it('a concurrent single queue() waits on the same lock and is counted', async () => {
    const other = (await createTenant(h)).id;
    const admin = (await addMember(h, other, { roles: ['ADMIN'] })).userId;
    const runner = h.app.get(TenantJobRunner);
    const sms = h.app.get(TenantSmsService);
    const single = (key: string) =>
      runner.run(
        other,
        () =>
          sms.queue({
            purpose: 'ATTENDANCE_ENTRY',
            phone: randomPhone(),
            body: 'absent',
            localDate: today,
            dedupeKey: key,
            delayMs: 60_000,
            dailyCap: 3,
            overCap: 'SKIP',
          }),
        { actorUserId: admin },
      );
    const all = runner.run(
      other,
      () => sms.queueAll(batch(3, 'race'), { dailyCap: 3, localDate: today }),
      { actorUserId: admin },
    );
    const [a, b] = await Promise.all([all, single(`race-single-${randomUUID()}`)]);
    // Whichever took the lock first: never 4 SMS for a cap of 3.
    const total = await withTenant(h.prisma, other, (tx) =>
      tx.smsLog.count({ where: { status: { in: ['QUEUED', 'SENT'] } } }),
    );
    expect(total).toBeLessThanOrEqual(3);
    expect(a.outcome === 'OVER_CAP' || b === 'OVER_CAP').toBe(true);
  });
});

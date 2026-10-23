import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import { todayIn } from '@jantrik/shared';
import { TenantSmsService, type QueueTenantSmsInput } from '../src/sms/tenant-sms.service.js';
import { TenantJobRunner } from '../src/tenancy/tenant-job-runner.service.js';
import {
  addMember,
  createHarness,
  createTenant,
  randomPhone,
  type Harness,
} from './support/harness.js';

/** The daily cap: held (attendance, fees) or skipped without a row (exam results). */
describe('tenant SMS over the daily cap', () => {
  let h: Harness;
  let tenantId: string;
  let actorUserId: string;

  const input = (dedupeKey: string, extra: Partial<QueueTenantSmsInput> = {}) => ({
    purpose: 'ATTENDANCE_ABSENT' as const,
    phone: randomPhone(),
    body: 'test',
    localDate: todayIn('Asia/Dhaka'),
    dedupeKey,
    delayMs: 60_000,
    dailyCap: 1,
    ...extra,
  });
  const queue = (i: QueueTenantSmsInput) =>
    h.app
      .get(TenantJobRunner)
      .run(tenantId, () => h.app.get(TenantSmsService).queue(i), { actorUserId });
  const logs = (dedupeKey: string) =>
    withTenant(h.prisma, tenantId, (tx) => tx.smsLog.findMany({ where: { dedupeKey } }));

  beforeAll(async () => {
    h = await createHarness();
    tenantId = (await createTenant(h, { modules: ['ATTENDANCE'] })).id;
    actorUserId = (await addMember(h, tenantId, { roles: ['ADMIN'] })).userId;
    // Uses up today's cap of 1.
    await expect(queue(input(`cap-${randomUUID()}`))).resolves.toBe('QUEUED');
  });
  afterAll(() => h.close());

  it('holds by default (the row keeps its dedupe key)', async () => {
    const key = `hold-${randomUUID()}`;
    await expect(queue(input(key))).resolves.toBe('HELD_OVER_LIMIT');
    expect((await logs(key)).map((l) => l.status)).toEqual(['HELD_OVER_LIMIT']);
  });

  it('SKIP writes no row, so the same key can be sent on another day', async () => {
    const key = `skip-${randomUUID()}`;
    await expect(queue(input(key, { overCap: 'SKIP' }))).resolves.toBe('OVER_CAP');
    expect(await logs(key)).toEqual([]);
    await expect(queue(input(key, { overCap: 'SKIP', dailyCap: 100 }))).resolves.toBe('QUEUED');
    expect((await logs(key)).map((l) => l.status)).toEqual(['QUEUED']);
  });

  it('SKIP still reports a duplicate first', async () => {
    const key = `dup-${randomUUID()}`;
    await expect(queue(input(key, { dailyCap: 100 }))).resolves.toBe('QUEUED');
    await expect(queue(input(key, { overCap: 'SKIP' }))).resolves.toBe('DUPLICATE');
  });
});

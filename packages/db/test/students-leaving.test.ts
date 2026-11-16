import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant } from './helpers.js';

/** students.left_on / leave_reason (P5, S14): leaving is a status, not a deletion. */
describe('students: leaving columns', () => {
  let app: PrismaClient;
  let tenantId: string;

  beforeAll(async () => {
    app = appClient();
    tenantId = (await createTenant(app)).id;
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  const create = (data: Record<string, unknown>) =>
    withTenant(app, tenantId, (tx) =>
      tx.student.create({
        data: { tenantId, studentCode: `L-${randomUUID().slice(0, 8)}`, nameEn: 'L', ...data },
        select: { id: true, status: true, leftOn: true, leaveReason: true, deletedAt: true },
      }),
    );

  it('an ACTIVE student cannot have a leaving date', async () => {
    await expect(create({ leftOn: new Date('2026-12-31') })).rejects.toThrow(/check constraint/i);
  });

  it('a GRADUATED student keeps a date and a reason and is not deleted', async () => {
    const s = await create({
      status: 'GRADUATED',
      leftOn: new Date('2026-12-31'),
      leaveReason: 'Passed SSC',
    });
    expect(s).toMatchObject({ status: 'GRADUATED', leaveReason: 'Passed SSC', deletedAt: null });
  });

  it('a reason needs a date, and is at most 500 characters', async () => {
    await expect(create({ status: 'TRANSFERRED', leaveReason: 'moved' })).rejects.toThrow(
      /check constraint/i,
    );
    await expect(
      create({
        status: 'TRANSFERRED',
        leftOn: new Date('2026-06-01'),
        leaveReason: 'x'.repeat(501),
      }),
    ).rejects.toThrow(/check constraint/i);
  });

  it('back to ACTIVE only with the date cleared', async () => {
    const s = await create({ status: 'DROPPED_OUT', leftOn: new Date('2026-05-01') });
    await expect(
      withTenant(app, tenantId, (tx) =>
        tx.student.update({ where: { id: s.id }, data: { status: 'ACTIVE' } }),
      ),
    ).rejects.toThrow(/check constraint/i);
    const back = await withTenant(app, tenantId, (tx) =>
      tx.student.update({
        where: { id: s.id },
        data: { status: 'ACTIVE', leftOn: null, leaveReason: null },
        select: { status: true },
      }),
    );
    expect(back.status).toBe('ACTIVE');
  });
});

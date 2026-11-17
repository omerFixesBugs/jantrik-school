import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient as GeneratedPrismaClient } from '../src/generated/prisma/client.js';
import { CLIENT_OMIT, withContext, withTenant, type PrismaClient } from '../src/index.js';
import { APP_URL } from './env.js';
import { appClient, createStudent, createTenant, singleConnectionAppClient } from './helpers.js';

// P1-J8 review round 2 (the reviewer's hold-cursor probe, as a test). An SQL injection in SQL the
// app sends outside a transaction can send several statements and leave a transaction open with a
// WITH HOLD cursor. Before the fix, the next request on that pooled connection (another
// institute's) signed THAT transaction, the cursor was filled at its COMMIT with the victim's
// rows, and the attacker read them later with FETCH. Two defences: the pool closes a connection
// released with a transaction open (createPrismaClient), and withContext refuses to sign a
// transaction that is not fresh.

const PLANT = (cursor: string) => `SELECT 1; BEGIN; DECLARE ${cursor} CURSOR WITH HOLD FOR
  SELECT s.name_en, s.tenant_id::text AS tenant_id FROM public.students s`;

describe('a transaction left open on a pooled connection never reaches the next request', () => {
  let app: PrismaClient;
  let attackerTenant: string;
  let victimTenant: string;

  beforeAll(async () => {
    app = appClient();
    attackerTenant = (await createTenant(app)).id;
    victimTenant = (await createTenant(app)).id;
    await createStudent(app, victimTenant, 'VICTIM-1');
    await createStudent(app, attackerTenant, 'ATTACKER-1');
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  /** The attacker's later request, in its own institute: read what the cursor holds. */
  const fetchLeak = (client: PrismaClient, cursor: string) =>
    withTenant(client, attackerTenant, (tx) =>
      tx.$queryRawUnsafe<{ tenant_id: string }[]>(`FETCH ALL FROM ${cursor}`),
    );

  it('outside a transaction (autocommit): the pool closes the connection, the cursor is gone', async () => {
    const pooled = singleConnectionAppClient(); // one connection: the next request gets it
    try {
      const pid = async () =>
        (await pooled.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      const before = await pid();
      await pooled.$executeRawUnsafe(PLANT('leak_a'));
      // The victim's request on the (only) pooled connection: a new one, its transaction fresh.
      expect(await withTenant(pooled, victimTenant, (tx) => tx.student.count())).toBe(1);
      expect(await pid()).not.toBe(before);
      await expect(fetchLeak(pooled, 'leak_a')).rejects.toThrow(/cursor "leak_a" does not exist/);
    } finally {
      await pooled.$disconnect();
    }
  });

  it('inside a signed transaction (COMMIT; BEGIN; DECLARE …): nothing of the victim reaches the cursor', async () => {
    const pooled = singleConnectionAppClient();
    try {
      await withContext(pooled, { tenantId: attackerTenant }, (tx) =>
        tx.$executeRawUnsafe(`SELECT 1; COMMIT; ${PLANT('leak_b').replace('SELECT 1; ', '')}`),
      );
      expect(await withTenant(pooled, victimTenant, (tx) => tx.student.count())).toBe(1);
      const leaked = await fetchLeak(pooled, 'leak_b').catch(() => []);
      expect(leaked.filter((r) => r.tenant_id === victimTenant)).toEqual([]);
    } finally {
      await pooled.$disconnect();
    }
  });

  it('even on a pool without that guard, withContext refuses to sign the leftover transaction', async () => {
    // The second line: a client built without createPrismaClient's guarded pool.
    const unguarded = new GeneratedPrismaClient({
      adapter: new PrismaPg({ connectionString: APP_URL, max: 1 }),
      omit: CLIENT_OMIT,
    }) as unknown as PrismaClient;
    try {
      await unguarded.$executeRawUnsafe(PLANT('leak_c'));
      await expect(withTenant(unguarded, victimTenant, (tx) => tx.student.count())).rejects.toThrow(
        /Refusing to sign the request context: this transaction was not fresh/,
      );
      // The refusal rolled the leftover transaction back, cursor and all; the connection is clean.
      await expect(fetchLeak(unguarded, 'leak_c')).rejects.toThrow(
        /cursor "leak_c" does not exist/,
      );
      expect(await withTenant(unguarded, victimTenant, (tx) => tx.student.count())).toBe(1);
    } finally {
      await unguarded.$disconnect();
    }
  });
});

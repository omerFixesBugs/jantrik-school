import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPlatformSession, withTenant, type PrismaClient, type TenantTx } from '../src/index.js';
import {
  appClient,
  createStudent,
  createTenant,
  newPlatformSession,
  ownerClient,
  platformClient,
  randomPhone,
} from './helpers.js';

// Step 8, part 4: usage and cost. The SMS rate is one global setting the app may only read;
// costs are stored on each SMS when sent; the platform reads counts and costs, never a phone
// number or a text. (The rate itself is changed in the API tests only: CI runs this package's
// tests next to the API's, against the same database.)

const DENIED = /permission denied/i;

describe('platform usage and cost', () => {
  let app: PrismaClient;
  let platform: PrismaClient;
  let owner: PrismaClient;
  let session: { tokenHash: string };

  const asPlatform = <T>(fn: (tx: TenantTx) => Promise<T>) =>
    withPlatformSession(platform, session.tokenHash, fn);
  /** Today in Dhaka (UTC+6, no daylight saving): the month the functions use. */
  const dhakaToday = () => new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
  const thisMonth = () => dhakaToday().slice(0, 7);

  beforeAll(async () => {
    app = appClient();
    platform = platformClient();
    owner = ownerClient();
    session = await newPlatformSession(owner);
  });

  afterAll(async () => {
    await Promise.all([app.$disconnect(), platform.$disconnect(), owner.$disconnect()]);
  });

  it('the new functions refuse without a platform session', async () => {
    for (const sql of [
      `SELECT platform_get_settings()`,
      `SELECT platform_set_sms_cost(30, NULL)`,
      `SELECT platform_usage('2026-10-01')`,
      `SELECT * FROM platform_usage_institutes('2026-10-01', 0, 10)`,
    ]) {
      await expect(platform.$queryRawUnsafe(sql)).rejects.toThrow(/platform session required/);
    }
  });

  it('the app reads only the rate; the platform reads costs, never phones or texts', async () => {
    const [rate] = await app.$queryRaw<{ paisa: number }[]>`
      SELECT sms_cost_per_segment_paisa AS paisa FROM platform_settings`;
    expect(rate!.paisa).toBeGreaterThanOrEqual(0);
    await expect(app.$queryRaw`SELECT updated_by_id FROM platform_settings`).rejects.toThrow(
      DENIED,
    );
    await expect(
      app.$executeRaw`UPDATE platform_settings SET sms_cost_per_segment_paisa = 0`,
    ).rejects.toThrow(DENIED);
    const [row] = await owner.$queryRaw<{ allowed: string[] }[]>`
      WITH c(tbl, col) AS (VALUES
        ('sms_logs', 'cost_paisa'), ('sms_logs', 'phone'), ('sms_logs', 'body'),
        ('platform_sms_logs', 'cost_paisa'), ('platform_sms_logs', 'segments'),
        ('platform_sms_logs', 'phone'), ('platform_sms_logs', 'error'))
      SELECT ARRAY(SELECT tbl || '.' || col FROM c
                   WHERE has_column_privilege('jantrik_platform', tbl, col, 'SELECT')) AS allowed`;
    expect(row!.allowed.sort()).toEqual([
      'platform_sms_logs.cost_paisa',
      'platform_sms_logs.segments',
      'sms_logs.cost_paisa',
    ]);
  });

  it('the rate is between ৳0 and ৳100', async () => {
    for (const bad of [-1, 10_001]) {
      await expect(
        asPlatform((tx) => tx.$executeRaw`SELECT platform_set_sms_cost(${bad}::int, NULL)`),
      ).rejects.toThrow(/PLATFORM_BAD_RATE/);
    }
    const [s] = await asPlatform(
      (tx) => tx.$queryRaw<{ v: { smsCostPerSegmentPaisa: number } }[]>`
        SELECT platform_get_settings() AS v`,
    );
    expect(s!.v.smsCostPerSegmentPaisa).toBeGreaterThanOrEqual(0);
  });

  it('usage: the month’s sent SMS with their stored costs, totals and per institute', async () => {
    const t = await createTenant(app);
    await createStudent(app, t.id, 'U-1');
    const today = new Date(`${dhakaToday()}T00:00:00Z`);
    await withTenant(app, t.id, async (tx) => {
      const sms = (status: 'SENT' | 'QUEUED' | 'FAILED', segments: number, cost: number | null) =>
        tx.smsLog.create({
          data: {
            tenantId: t.id,
            phone: randomPhone(),
            purpose: 'ATTENDANCE_ABSENT',
            status,
            segments,
            costPaisa: cost,
            body: 'x',
            localDate: today,
          },
        });
      await sms('SENT', 2, 60);
      await sms('SENT', 1, 25); // sent at an older, lower rate
      await sms('QUEUED', 1, null);
      await sms('FAILED', 1, null);
    });
    const [u] = await asPlatform(
      (tx) => tx.$queryRaw<{ v: { institutesSms: { count: number; costPaisa: number } } }[]>`
        SELECT platform_usage(${`${thisMonth()}-01`}::date) AS v`,
    );
    expect(u!.v.institutesSms.count).toBeGreaterThanOrEqual(2);
    expect(u!.v.institutesSms.costPaisa).toBeGreaterThanOrEqual(85);
    // Page through every institute (a long-lived local test database has many).
    type Row = {
      id: string;
      sms_sent: bigint;
      sms_segments: bigint;
      sms_cost_paisa: bigint;
      active_students: bigint;
      total: bigint;
    };
    let mine: Row | undefined;
    for (let offset = 0; !mine; offset += 100) {
      const rows = await asPlatform(
        (tx) => tx.$queryRaw<Row[]>`
          SELECT * FROM platform_usage_institutes(${`${thisMonth()}-01`}::date, ${offset}::int, 100)`,
      );
      if (rows.length === 0) break;
      mine = rows.find((r) => r.id === t.id);
    }
    expect(mine).toMatchObject({
      sms_sent: 2n,
      sms_segments: 3n,
      sms_cost_paisa: 85n,
      active_students: 1n,
    });
    const [d] = await asPlatform(
      (tx) => tx.$queryRaw<{ v: { counts: { smsCostThisMonth: number } } }[]>`
        SELECT platform_get_institute(${t.id}::uuid) AS v`,
    );
    expect(d!.v.counts.smsCostThisMonth).toBe(85);
  });
});

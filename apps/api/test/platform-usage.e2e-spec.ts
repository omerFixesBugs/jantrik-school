import { randomUUID } from 'node:crypto';
import { withTenant } from '@jantrik/db';
import {
  todayIn,
  type AttendanceStatus,
  type PlatformSettings,
  type PlatformUsage,
} from '@jantrik/shared';
import {
  addMember,
  bearer,
  createHarness,
  http,
  otpLogin,
  type Harness,
} from './support/harness.js';
import { ownerClient, platform, platformAdminCookie } from './support/platform.js';
import { school, type School } from './support/school.js';

// Step 8, part 4: the SMS rate (a platform setting, audited) is copied onto every SMS when it is
// sent, so a later change keeps past costs; usage shows the month's counts and costs.

const TODAY = () => todayIn('Asia/Dhaka');

describe('platform: usage and cost', () => {
  let h: Harness;
  let cookie: string;
  let s: School;
  const p = () => platform(h, cookie);
  const setRate = (paisa: number) =>
    p().put('/platform/settings').send({ smsCostPerSegmentPaisa: paisa });
  const absent = (studentIndex: number) =>
    http(h)
      .put('/attendance/sessions')
      .set(bearer(s.teacher))
      .send({
        sectionId: s.sectionA,
        date: TODAY(),
        baseVersion: 0,
        submissionId: randomUUID(),
        records: s.a.map((st, i) => ({
          studentId: st.id,
          status: (i === studentIndex ? 'ABSENT' : 'PRESENT') as AttendanceStatus,
        })),
      });
  const sentLogs = async () =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.smsLog.findMany({ where: { status: 'SENT' }, orderBy: { createdAt: 'asc' } }),
    );

  beforeAll(async () => {
    h = await createHarness();
    cookie = await platformAdminCookie(h);
    s = await school(h);
  });

  afterAll(async () => {
    await setRate(30); // the starting rate, for the other test files
    await h.close();
  });

  it('settings: platform session only; ৳0–৳100; changes are audited', async () => {
    await platform(h).get('/platform/settings').set(bearer(s.admin)).expect(401);
    await setRate(-1).expect(400);
    await setRate(10_001).expect(400);
    const set = (await setRate(30).expect(200)).body as PlatformSettings;
    expect(set).toMatchObject({ smsCostPerSegmentPaisa: 30, updatedBy: 'Test Platform Admin' });
    const owner = ownerClient();
    try {
      const [log] = await owner.platformAuditLog.findMany({
        where: { action: 'SETTINGS_SMS_COST' },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      expect(log?.details).toMatchObject({ to: 30 });
    } finally {
      await owner.$disconnect();
    }
  });

  it('a sent SMS keeps the rate it was sent at; usage counts it', async () => {
    await setRate(30).expect(200);
    await absent(0).expect(200);
    await vi.waitFor(
      async () => {
        if ((await sentLogs()).length < 1) throw new Error('not sent yet');
      },
      { timeout: 10_000, interval: 50 },
    );
    const [first] = await sentLogs();
    expect(first!.costPaisa).toBe(first!.segments * 30);

    // A new rate applies to the next SMS only (section B, taken by the admin).
    await setRate(45).expect(200);
    await http(h)
      .put('/attendance/sessions')
      .set(bearer(s.admin))
      .send({
        sectionId: s.sectionB,
        date: TODAY(),
        baseVersion: 0,
        submissionId: randomUUID(),
        records: s.b.map((st) => ({ studentId: st.id, status: 'ABSENT' as AttendanceStatus })),
      })
      .expect(200);
    await vi.waitFor(
      async () => {
        if ((await sentLogs()).length < 2) throw new Error('not sent yet');
      },
      { timeout: 10_000, interval: 50 },
    );
    const both = await sentLogs();
    expect(both[0]!.costPaisa).toBe(both[0]!.segments * 30); // unchanged
    expect(both[1]!.costPaisa).toBe(both[1]!.segments * 45);

    // Page through every institute (a long-lived local test database has many).
    const month = TODAY().slice(0, 7);
    const usageAt = async (page: number) =>
      (await p().get(`/platform/usage?month=${month}&pageSize=100&page=${page}`).expect(200))
        .body as PlatformUsage;
    const usage = await usageAt(1);
    expect(usage.smsCostPerSegmentPaisa).toBe(45);
    let found = usage.items.find((i) => i.id === s.tenantId);
    for (let page = 2; !found && (page - 1) * 100 < usage.total; page++) {
      found = (await usageAt(page)).items.find((i) => i.id === s.tenantId);
    }
    const mine = found!;
    expect(mine).toMatchObject({
      smsSent: both.length,
      smsCostPaisa: both.reduce((sum, l) => sum + (l.costPaisa ?? 0), 0),
    });
    expect(usage.institutesSms.costPaisa).toBeGreaterThanOrEqual(mine.smsCostPaisa);
    expect(usage.totalCostPaisa).toBe(usage.institutesSms.costPaisa + usage.loginSms.costPaisa);
  });

  it('a login code (OTP) is logged with its cost, and counted as login SMS', async () => {
    await setRate(25).expect(200);
    const { phone } = await addMember(h, s.tenantId, { roles: ['TEACHER'] });
    await otpLogin(h, phone);
    const owner = ownerClient();
    try {
      await vi.waitFor(
        async () => {
          const rows = await owner.platformSmsLog.findMany({ where: { phone } });
          if (rows.length === 0) throw new Error('not logged yet');
          expect(rows[0]).toMatchObject({ status: 'SENT', costPaisa: rows[0]!.segments * 25 });
        },
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      await owner.$disconnect();
    }
    const usage = (await p().get('/platform/usage').expect(200)).body as PlatformUsage;
    expect(usage.loginSms.count).toBeGreaterThanOrEqual(1);
    expect(usage.loginSms.costPaisa).toBeGreaterThanOrEqual(25);
  });

  it('usage pages, and never shows a phone number or an SMS text', async () => {
    const res = await p().get('/platform/usage?page=999').expect(200);
    expect((res.body as PlatformUsage).items).toEqual([]);
    expect((res.body as PlatformUsage).total).toBeGreaterThan(0);
    const full = await p().get('/platform/usage?pageSize=100').expect(200);
    for (const st of [...s.a, ...s.b]) expect(full.text).not.toContain(st.phone);
    const logs = await sentLogs();
    for (const l of logs) expect(full.text).not.toContain(l.body.slice(0, 20));
    await p().get('/platform/usage?month=2026-13').expect(400);
  });
});

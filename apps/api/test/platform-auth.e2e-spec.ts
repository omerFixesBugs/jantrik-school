import { totpCode, totpStep, type PrismaClient } from '@jantrik/db';
import type { PlatformAdminInfo, PlatformAuditEntry, PlatformLoginResponse } from '@jantrik/shared';
import {
  addMember,
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  type Harness,
} from './support/harness.js';
import {
  cookieFrom,
  createPlatformAdmin,
  freshCode,
  ownerClient,
  platform,
  platformLogin,
} from './support/platform.js';

// Step 8, part 1: platform admins (Jantrik's own staff). Password + TOTP (authenticator app),
// one-time backup codes, a short cookie session, every action audited, and complete separation
// from institute logins in both directions.
describe('platform auth', () => {
  let h: Harness;
  let owner: PrismaClient;

  beforeAll(async () => {
    h = await createHarness();
    owner = ownerClient();
  });

  afterAll(async () => {
    await h.close();
    await owner.$disconnect();
  });

  it('first login: password, then enrol the authenticator app; 10 backup codes once; httpOnly cookie', async () => {
    const admin = await createPlatformAdmin(owner);
    const step1 = await platform(h)
      .post('/platform/auth/login')
      .send({ identifier: admin.phone, password: admin.password })
      .expect(200);
    const body = step1.body as PlatformLoginResponse;
    expect(body.enrol?.uri).toMatch(/^otpauth:\/\/totp\/Jantrik%20Platform%3A/);
    expect(step1.headers['set-cookie']).toBeUndefined(); // the password alone opens nothing
    admin.secret = body.enrol!.secret;

    const wrong = await platform(h)
      .post('/platform/auth/verify')
      .send({ challengeId: body.challengeId, code: '000000' })
      .expect(401);
    expect(wrong.body).toMatchObject({ code: 'INVALID_CODE', attemptsLeft: 4 });

    const ok = await platform(h)
      .post('/platform/auth/verify')
      .send({ challengeId: body.challengeId, code: freshCode(admin) })
      .expect(200);
    expect(ok.body.backupCodes).toHaveLength(10);
    const raw = (ok.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('jantrik_ps='),
    )!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\/platform/);
    expect(raw).toMatch(/Secure/i);
    const me = (await platform(h, cookieFrom(raw)).get('/platform/auth/me').expect(200))
      .body as PlatformAdminInfo;
    expect(me).toMatchObject({ phone: admin.phone, backupCodesLeft: 10 });
    expect(me.totpEnabledAt).not.toBeNull();
    // The challenge is single use.
    await platform(h)
      .post('/platform/auth/verify')
      .send({ challengeId: body.challengeId, code: freshCode(admin) })
      .expect(401);
  });

  it('wrong password and unknown account look the same; disabled admins cannot sign in', async () => {
    const admin = await createPlatformAdmin(owner);
    const wrong = await platform(h)
      .post('/platform/auth/login')
      .send({ identifier: admin.phone, password: 'not-the-password' })
      .expect(401);
    const unknown = await platform(h)
      .post('/platform/auth/login')
      .send({ identifier: '01799999999', password: 'whatever-password' })
      .expect(401);
    expect(wrong.body).toEqual(unknown.body);
    await owner.platformAdmin.update({ where: { id: admin.id }, data: { isActive: false } });
    const disabled = await platform(h)
      .post('/platform/auth/login')
      .send({ identifier: admin.phone, password: admin.password })
      .expect(401);
    expect(disabled.body).toEqual(unknown.body);
  });

  it('the second factor: a code is used once, a backup code once, 5 wrong codes end the challenge', async () => {
    const admin = await createPlatformAdmin(owner);
    const { backupCodes } = await platformLogin(h, admin); // enrol

    // Replay: the same time step's code again.
    const login = async () =>
      (
        await platform(h)
          .post('/platform/auth/login')
          .send({ identifier: admin.phone, password: admin.password })
          .expect(200)
      ).body as PlatformLoginResponse;
    const used = [...admin.usedSteps][0]!;
    let c = await login();
    expect(c.enrol).toBeUndefined();
    await platform(h)
      .post('/platform/auth/verify')
      .send({ challengeId: c.challengeId, code: totpCode(admin.secret!, used) })
      .expect(401);

    // A backup code works once (any case, with or without the dash).
    const code = backupCodes![0]!;
    await platform(h)
      .post('/platform/auth/verify')
      .send({ challengeId: c.challengeId, code: code.toLowerCase().replace('-', '') })
      .expect(200);
    c = await login();
    await platform(h)
      .post('/platform/auth/verify')
      .send({ challengeId: c.challengeId, code })
      .expect(401);
  });

  it('five wrong codes end the challenge, even for a right code afterwards', async () => {
    // (Separate admins: each admin also has at most 10 code attempts per 15 minutes.)
    const login = async (admin: Awaited<ReturnType<typeof createPlatformAdmin>>) =>
      (
        await platform(h)
          .post('/platform/auth/login')
          .send({ identifier: admin.phone, password: admin.password })
          .expect(200)
      ).body as PlatformLoginResponse;
    const wrong = (challengeId: string, code: string) =>
      platform(h).post('/platform/auth/verify').send({ challengeId, code }).expect(401);

    const lucky = await createPlatformAdmin(owner);
    await platformLogin(h, lucky);
    let c = await login(lucky);
    for (let i = 0; i < 4; i++) await wrong(c.challengeId, '111111');
    await platform(h)
      .post('/platform/auth/verify')
      .send({ challengeId: c.challengeId, code: freshCode(lucky) })
      .expect(200); // the 5th attempt may still be right

    const unlucky = await createPlatformAdmin(owner);
    await platformLogin(h, unlucky);
    c = await login(unlucky);
    for (let i = 0; i < 5; i++) await wrong(c.challengeId, '222222');
    const locked = await platform(h)
      .post('/platform/auth/verify')
      .send({ challengeId: c.challengeId, code: totpCode(unlucky.secret!, totpStep()) })
      .expect(401);
    expect(locked.body.code).toBe('CHALLENGE_EXPIRED');
  });

  it('platform and institute logins never cross', async () => {
    const admin = await createPlatformAdmin(owner);
    const { cookie } = await platformLogin(h, admin);
    const tenantId = (await createTenant(h)).id;
    const institute = (
      await otpLogin(h, (await addMember(h, tenantId, { roles: ['OWNER'] })).phone)
    ).accessToken;

    // An institute token is not a platform session.
    await platform(h).get('/platform/auth/me').set(bearer(institute)).expect(401);
    // The platform cookie is not an institute login.
    await http(h).get('/auth/me').set('Cookie', cookie).expect(401);
    await http(h)
      .get('/students')
      .set('Cookie', cookie)
      .set('X-Jantrik-Client', 'platform')
      .expect(401);
    // Platform requests must come from the platform app (CSRF defence), cookie or not.
    await http(h).get('/platform/auth/me').set('Cookie', cookie).expect(403);
    await http(h)
      .post('/platform/auth/login')
      .send({ identifier: admin.phone, password: admin.password })
      .expect(403);
  });

  it('short sessions: idle and absolute expiry, logout and disabling end them at once', async () => {
    // One admin per case: a TOTP step is accepted once, so quick logins use different admins.
    const signedIn = async () => {
      const admin = await createPlatformAdmin(owner);
      const { cookie } = await platformLogin(h, admin);
      const [s] = await owner.$queryRaw<{ id: string }[]>`
        SELECT id FROM platform_sessions WHERE admin_id = ${admin.id}::uuid`;
      return { admin, cookie, sessionId: s!.id };
    };

    const idle = await signedIn();
    await platform(h, idle.cookie).get('/platform/auth/me').expect(200);
    await owner.$executeRaw`UPDATE platform_sessions SET idle_expires_at = now() - interval '1 second' WHERE id = ${idle.sessionId}::uuid`;
    await platform(h, idle.cookie).get('/platform/auth/me').expect(401);

    const old = await signedIn();
    await owner.$executeRaw`UPDATE platform_sessions SET expires_at = now() - interval '1 second', idle_expires_at = now() - interval '1 second' WHERE id = ${old.sessionId}::uuid`;
    await platform(h, old.cookie).get('/platform/auth/me').expect(401);

    const out = await signedIn();
    const me = (await platform(h, out.cookie).get('/platform/auth/me').expect(200))
      .body as PlatformAdminInfo;
    const hours = (Date.parse(me.sessionExpiresAt!) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(7.9);
    expect(hours).toBeLessThanOrEqual(8);
    await platform(h, out.cookie).post('/platform/auth/logout').expect(204);
    await platform(h, out.cookie).get('/platform/auth/me').expect(401);

    const off = await signedIn();
    await owner.platformAdmin.update({ where: { id: off.admin.id }, data: { isActive: false } });
    await platform(h, off.cookie).get('/platform/auth/me').expect(401);
  });

  it('every login, failed code and logout is in the audit log', async () => {
    const admin = await createPlatformAdmin(owner);
    const { cookie } = await platformLogin(h, admin);
    const c = (
      await platform(h)
        .post('/platform/auth/login')
        .send({ identifier: admin.phone, password: admin.password })
        .expect(200)
    ).body as PlatformLoginResponse;
    await platform(h)
      .post('/platform/auth/verify')
      .send({ challengeId: c.challengeId, code: '333333' })
      .expect(401);
    const second = (await platformLogin(h, admin)).cookie;
    await platform(h, second).post('/platform/auth/logout').expect(204);

    const audit = (await platform(h, cookie).get('/platform/audit?limit=200').expect(200))
      .body as PlatformAuditEntry[];
    const mine = audit.filter((a) => a.adminName === 'Test Platform Admin' && a.actor === 'ADMIN');
    const actions = mine.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['LOGIN', 'LOGIN_FAILED', 'LOGOUT']));
    expect(mine.find((a) => a.action === 'LOGIN')!.details).toMatchObject({ method: 'TOTP' });
    expect(mine.find((a) => a.action === 'LOGIN_FAILED')!.details).toMatchObject({
      reason: 'BAD_CODE',
    });
  });

  it('setting up the authenticator needs the window the CLI opened (a password alone is not enough later)', async () => {
    const admin = await createPlatformAdmin(owner, { enrolBy: null });
    const r = await platform(h)
      .post('/platform/auth/login')
      .send({ identifier: admin.phone, password: admin.password })
      .expect(403);
    expect(r.body.code).toBe('ENROLMENT_CLOSED');
    expect(r.body.challengeId).toBeUndefined();
    const audit = await owner.platformAuditLog.findMany({ where: { adminId: admin.id } });
    expect(audit.map((a) => [a.action, (a.details as { reason?: string }).reason])).toEqual([
      ['LOGIN_FAILED', 'ENROLMENT_CLOSED'],
    ]);
  });

  it('a password change or 2FA reset in between voids a pending login', async () => {
    const admin = await createPlatformAdmin(owner);
    await platformLogin(h, admin); // enrol
    const c = (
      await platform(h)
        .post('/platform/auth/login')
        .send({ identifier: admin.phone, password: admin.password })
        .expect(200)
    ).body as PlatformLoginResponse;
    // e.g. `pnpm platform:admin password` while the code step is open
    await owner.platformAdmin.update({
      where: { id: admin.id },
      data: { passwordHash: 'changed' },
    });
    const r = await platform(h)
      .post('/platform/auth/verify')
      .send({ challengeId: c.challengeId, code: freshCode(admin) })
      .expect(401);
    expect(r.body.code).toBe('CHALLENGE_EXPIRED');
  });

  it('wrong passwords on a real account are in the audit log', async () => {
    const admin = await createPlatformAdmin(owner);
    await platform(h)
      .post('/platform/auth/login')
      .send({ identifier: admin.phone, password: 'not-it' })
      .expect(401);
    const audit = await owner.platformAuditLog.findMany({ where: { adminId: admin.id } });
    expect(audit.map((a) => (a.details as { reason?: string }).reason)).toEqual(['BAD_PASSWORD']);
  });

  it('password attempts are rate-limited per account', async () => {
    const admin = await createPlatformAdmin(owner);
    for (let i = 0; i < 5; i++) {
      await platform(h)
        .post('/platform/auth/login')
        .send({ identifier: admin.phone, password: 'wrong-password' })
        .expect(401);
    }
    const limited = await platform(h)
      .post('/platform/auth/login')
      .send({ identifier: admin.phone, password: admin.password })
      .expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

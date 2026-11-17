import { provisionTenant, withContext, withTenant } from '@jantrik/db';
import { toBanglaDigits, type AuthResponse, type MembershipSummary } from '@jantrik/shared';
import { OtpService } from '../src/auth/otp.service.js';
import {
  addMember,
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  randomIp,
  waitForOtp,
  type Harness,
} from './support/harness.js';

// Sprint 1 P1: staff set their own password after a code sent to their phone (S26, P1-A..E).
const GOOD = 'tea garden monsoon 7';
const GOOD_2 = 'river boat lantern 42';

describe('staff set their own password', () => {
  let h: Harness;
  let tenantId: string;

  beforeAll(async () => {
    h = await createHarness();
    tenantId = (await createTenant(h)).id;
  });

  afterAll(async () => {
    await h.close();
  });

  /** An institute with a name of its own (createTenant names every one "Test Institute"). */
  const namedTenant = (name: string) =>
    provisionTenant(h.prisma, {
      slug: `t-${Math.random().toString(36).slice(2, 10)}`,
      name,
      instituteTypeKey: 'NCTB_SCHOOL_BN',
      status: 'ACTIVE',
      modules: [],
      academicYear: {
        name: '2026',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
      },
    });

  const status = (token: string) => http(h).get('/me/password').set(bearer(token));
  const sendCode = (token: string, ip = randomIp()) =>
    http(h).post('/me/password/code').set('X-Forwarded-For', ip).set(bearer(token)).send({});
  const setPassword = (token: string, code: string, password: string, ip = randomIp()) =>
    http(h)
      .put('/me/password')
      .set('X-Forwarded-For', ip)
      .set(bearer(token))
      .send({ code, password });
  const passwordLogin = (identifier: string, password: string) =>
    http(h)
      .post('/auth/login')
      .set('X-Forwarded-For', randomIp())
      .send({ identifier, password, client: 'mobile' });
  const refresh = (refreshToken: string) =>
    http(h).post('/auth/refresh').set('X-Forwarded-For', randomIp()).send({ refreshToken });

  /** Send a password code and read it from the SMS. */
  const codeFor = async (token: string, phone: string): Promise<string> => {
    const before = h.sms.sentTo(phone).length;
    await sendCode(token).expect(202);
    return waitForOtp(h, phone, before);
  };
  /** A teacher here, signed in with a login code. */
  const teacher = async (opts: { password?: string } = {}) => {
    const member = await addMember(h, tenantId, { roles: ['TEACHER'], ...opts });
    return { ...member, login: await otpLogin(h, member.phone) };
  };
  /** Simulate the 15-minute windows passing (the daily cap is left alone). */
  const passTime = (phone: string, userId: string) =>
    h.redis.del(
      `rl:otp-phone-cooldown:${phone}`,
      `rl:otp-password-cooldown:${phone}`,
      `rl:otp-phone-15m:${phone}`,
      `rl:pwd-set:${userId}`,
    );

  describe('a teacher with no password', () => {
    it('reads the status, gets a code by SMS, sets the password and signs in with it', async () => {
      const t = await teacher();
      // Their own phone too, so the form can check the rules as they type.
      expect((await status(t.login.accessToken).expect(200)).body).toEqual({
        hasPassword: false,
        changedAt: null,
        phone: t.phone,
      });

      const before = h.sms.sentTo(t.phone).length;
      const sent = await sendCode(t.login.accessToken).expect(202);
      const local = `0${t.phone.slice(4)}`;
      expect(sent.body).toEqual({
        expiresIn: 300,
        phoneHint: `${local.slice(0, 3)}•••••${local.slice(-3)}`,
      });
      const code = await waitForOtp(h, t.phone, before);
      expect(h.sms.sentTo(t.phone).at(-1)).toBe(
        `আপনার জান্ত্রিক পাসওয়ার্ড সেট করার কোড: ${code}। ৫ মিনিটের মধ্যে ব্যবহার করুন। কাউকে জানাবেন না।`,
      );

      const started = Date.now();
      await setPassword(t.login.accessToken, code, GOOD).expect(204);
      const login = await passwordLogin(t.phone, GOOD).expect(200);
      expect(login.body).toMatchObject({ user: { id: t.userId }, tenant: { id: tenantId } });

      const after = (await status(t.login.accessToken).expect(200)).body as {
        hasPassword: boolean;
        changedAt: string;
      };
      expect(after.hasPassword).toBe(true);
      expect(Date.parse(after.changedAt)).toBeGreaterThanOrEqual(started - 1000);

      const audit = await withTenant(h.prisma, tenantId, (tx) =>
        tx.auditLog.findMany({ where: { entity: 'user_password', entityId: t.userId } }),
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorUserId: t.userId,
        action: 'UPDATE',
        oldValues: null,
        newValues: null,
      });
    });

    it('the English text for a person who chose English', async () => {
      const t = await teacher();
      await http(h)
        .patch('/me/preferences')
        .set(bearer(t.login.accessToken))
        .send({ locale: 'en' })
        .expect(204);
      const code = await codeFor(t.login.accessToken, t.phone);
      expect(h.sms.sentTo(t.phone).at(-1)).toBe(
        `Your Jantrik code to set your password is ${code}. It expires in 5 minutes. Do not share it.`,
      );
    });
  });

  describe('who may (P1-A)', () => {
    it('staff in A and guardian in B: 403 while working in B, allowed in A; the password then reaches both (S28)', async () => {
      const b = (await createTenant(h)).id;
      const { phone, userId } = await addMember(h, tenantId, { roles: ['TEACHER'] });
      await addMember(h, b, { phone, roles: ['GUARDIAN'] });
      const login = await otpLogin(h, phone); // two institutes: none selected yet
      const tokenIn = async (id: string) =>
        (
          await http(h)
            .post('/auth/switch-tenant')
            .set(bearer(login.accessToken))
            .send({ tenantId: id })
            .expect(200)
        ).body.accessToken as string;

      const inB = await tokenIn(b);
      const smsBefore = h.sms.sentTo(phone).length;
      await status(inB).expect(403);
      await sendCode(inB).expect(403);
      await setPassword(inB, '123456', GOOD).expect(403);
      expect(h.sms.sentTo(phone)).toHaveLength(smsBefore);

      const inA = await tokenIn(tenantId);
      const code = await codeFor(inA, phone);
      await setPassword(inA, code, GOOD).expect(204);

      const pw = (await passwordLogin(phone, GOOD).expect(200)).body as AuthResponse;
      const memberships = (
        await http(h).get('/auth/memberships').set(bearer(pw.accessToken)).expect(200)
      ).body as MembershipSummary[];
      expect(
        memberships
          .filter((m) => m.selectable)
          .map((m) => m.tenant.id)
          .sort(),
      ).toEqual([tenantId, b].sort());
      expect(userId).toBe(pw.user.id);
    });

    it('a guardian only: 403 on all three routes, and nothing is sent', async () => {
      const { phone } = await addMember(h, tenantId, { roles: ['GUARDIAN'] });
      const login = await otpLogin(h, phone);
      const smsBefore = h.sms.sentTo(phone).length;
      await status(login.accessToken).expect(403);
      await sendCode(login.accessToken).expect(403);
      await setPassword(login.accessToken, '123456', GOOD).expect(403);
      expect(h.sms.sentTo(phone)).toHaveLength(smsBefore);
      expect(await h.redis.exists(`otp:password:${phone}`)).toBe(0);
    });

    it('without signing in: 401', async () => {
      await http(h).get('/me/password').expect(401);
      await http(h).post('/me/password/code').send({}).expect(401);
      await http(h).put('/me/password').send({ code: '123456', password: GOOD }).expect(401);
    });
  });

  describe('the code', () => {
    it('a wrong code: 422 PASSWORD_CODE_INVALID, and nothing changes', async () => {
      const t = await teacher();
      const code = await codeFor(t.login.accessToken, t.phone);
      const wrong = code === '000000' ? '000001' : '000000';
      const res = await setPassword(t.login.accessToken, wrong, GOOD).expect(422);
      expect(res.body).toMatchObject({ code: 'PASSWORD_CODE_INVALID' });
      expect((await status(t.login.accessToken)).body).toEqual({
        hasPassword: false,
        changedAt: null,
        phone: t.phone,
      });
    });

    it('is single use', async () => {
      const t = await teacher();
      const code = await codeFor(t.login.accessToken, t.phone);
      await setPassword(t.login.accessToken, code, GOOD).expect(204);
      const again = await setPassword(t.login.accessToken, code, GOOD_2).expect(422);
      expect(again.body).toMatchObject({ code: 'PASSWORD_CODE_INVALID' });
      await passwordLogin(t.phone, GOOD).expect(200);
    });

    it('is single use even when two requests race with it (login codes too)', async () => {
      const otp = h.app.get(OtpService);
      for (const purpose of ['password', 'login'] as const) {
        const { phone } = await addMember(h, tenantId, { roles: ['TEACHER'] });
        const before = h.sms.sentTo(phone).length;
        await otp.request(phone, randomIp(), purpose);
        const code = await waitForOtp(h, phone, before);
        const results = await Promise.all([
          otp.verify(phone, code, randomIp(), purpose),
          otp.verify(phone, code, randomIp(), purpose),
        ]);
        expect(results.filter(Boolean), purpose).toHaveLength(1);
      }
    });

    it('two PUTs with the same code at once: one sets the password, the other is refused', async () => {
      const t = await teacher();
      const code = await codeFor(t.login.accessToken, t.phone);
      const statuses = (
        await Promise.all([
          setPassword(t.login.accessToken, code, GOOD),
          setPassword(t.login.accessToken, code, GOOD_2),
        ])
      ).map((r) => r.status);
      expect(statuses.sort()).toEqual([204, 422]);
    });

    it('expires', async () => {
      const t = await teacher();
      const code = await codeFor(t.login.accessToken, t.phone);
      await h.redis.pexpire(`otp:password:${t.phone}`, 1);
      await vi.waitFor(async () => {
        if ((await h.redis.exists(`otp:password:${t.phone}`)) !== 0) throw new Error('still there');
      });
      await setPassword(t.login.accessToken, code, GOOD).expect(422);
    });

    it('accepts Bangla digits', async () => {
      const t = await teacher();
      const code = await codeFor(t.login.accessToken, t.phone);
      await setPassword(t.login.accessToken, toBanglaDigits(code), GOOD).expect(204);
      await passwordLogin(t.phone, GOOD).expect(200);
    });

    it('is stored only as an HMAC under its own key', async () => {
      const t = await teacher();
      const code = await codeFor(t.login.accessToken, t.phone);
      const stored = await h.redis.get(`otp:password:${t.phone}`);
      expect(stored).toMatch(/^[0-9a-f]{64}$/);
      expect(stored).not.toContain(code);
      expect(await h.redis.ttl(`otp:password:${t.phone}`)).toBeLessThanOrEqual(300);
    });

    it('changing an existing password needs a fresh code too', async () => {
      const t = await teacher({ password: GOOD });
      const res = await setPassword(t.login.accessToken, '123456', GOOD_2).expect(422);
      expect(res.body).toMatchObject({ code: 'PASSWORD_CODE_INVALID' });
      await passwordLogin(t.phone, GOOD).expect(200);
      const code = await codeFor(t.login.accessToken, t.phone);
      await setPassword(t.login.accessToken, code, GOOD_2).expect(204);
      await passwordLogin(t.phone, GOOD_2).expect(200);
      await passwordLogin(t.phone, GOOD).expect(401);
    });

    it('a refused password does not use up the code', async () => {
      const t = await teacher();
      const code = await codeFor(t.login.accessToken, t.phone);
      await setPassword(t.login.accessToken, code, 'short').expect(422);
      await setPassword(t.login.accessToken, code, GOOD).expect(204);
    });
  });

  describe('a login code and a password code are not interchangeable (review focus 5)', () => {
    it('a login code cannot set a password', async () => {
      const t = await teacher();
      await passTime(t.phone, t.userId);
      const before = h.sms.sentTo(t.phone).length;
      await http(h)
        .post('/auth/otp/request')
        .set('X-Forwarded-For', randomIp())
        .send({ phone: t.phone })
        .expect(202);
      const loginCode = await waitForOtp(h, t.phone, before);
      const res = await setPassword(t.login.accessToken, loginCode, GOOD).expect(422);
      expect(res.body).toMatchObject({ code: 'PASSWORD_CODE_INVALID' });
    });

    it('a password code cannot sign in', async () => {
      const t = await teacher();
      const code = await codeFor(t.login.accessToken, t.phone);
      await http(h)
        .post('/auth/otp/verify')
        .set('X-Forwarded-For', randomIp())
        .send({ phone: t.phone, code, client: 'mobile' })
        .expect(401);
      // ...and it still sets the password afterwards (the login path never touched it).
      await setPassword(t.login.accessToken, code, GOOD).expect(204);
    });

    it('right after signing in with a code, a password code can be sent (own cooldown)', async () => {
      const t = await teacher(); // the login code was sent a moment ago
      await sendCode(t.login.accessToken).expect(202);
      // A second password code within the cooldown is refused.
      const again = await sendCode(t.login.accessToken).expect(429);
      expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('login and password codes share the phone’s daily SMS cap', async () => {
      const t = await teacher(); // 1 login code
      await codeFor(t.login.accessToken, t.phone); // 1 password code
      expect(await h.redis.get(`rl:otp-phone-day:${t.phone}`)).toBe('2');
      expect(await h.redis.get(`rl:otp-phone-15m:${t.phone}`)).toBe('2');

      await h.redis.set(`rl:otp-phone-day:${t.phone}`, 10, 'KEEPTTL');
      await passTime(t.phone, t.userId);
      const before = h.sms.sentTo(t.phone).length;
      await sendCode(t.login.accessToken).expect(429);
      await http(h)
        .post('/auth/otp/request')
        .set('X-Forwarded-For', randomIp())
        .send({ phone: t.phone })
        .expect(429);
      expect(h.sms.sentTo(t.phone)).toHaveLength(before);
    });
  });

  describe('the rules (S26, P1-D)', () => {
    const rejected = async (token: string, password: string) => {
      const res = await setPassword(token, '123456', password).expect(422);
      expect(res.body.code).toBe('PASSWORD_REJECTED');
      return res.body.problems as string[];
    };

    it('too short, too long, common', async () => {
      const t = await teacher();
      expect(await rejected(t.login.accessToken, 'abcdefghi')).toEqual(['TOO_SHORT']);
      expect(await rejected(t.login.accessToken, 'a'.repeat(129))).toEqual(['TOO_LONG']);
      expect(await rejected(t.login.accessToken, 'password123')).toEqual(['TOO_COMMON']);
      expect(await rejected(t.login.accessToken, '1234567890')).toEqual(['TOO_COMMON']);
      await passTime(t.phone, t.userId);
      expect(await rejected(t.login.accessToken, 'Jantrik@2026')).toEqual(['TOO_COMMON']);
    });

    it('the phone number, in any form', async () => {
      const t = await teacher();
      const local = `0${t.phone.slice(4)}`;
      expect(await rejected(t.login.accessToken, `pw-${local}`)).toEqual(['HAS_PHONE']);
      expect(await rejected(t.login.accessToken, `pw ${t.phone}`)).toEqual(['HAS_PHONE']);
      expect(await rejected(t.login.accessToken, `pw ${toBanglaDigits(local)}`)).toEqual([
        'HAS_PHONE',
      ]);
    });

    it('the name of this institute or of another one the person belongs to (as a guardian too)', async () => {
      const here = (await namedTenant('Kodom Tola School')).id;
      const elsewhere = (await namedTenant('বকুল কোচিং সেন্টার')).id;
      const { phone, userId } = await addMember(h, here, { roles: ['TEACHER'] });
      await addMember(h, elsewhere, { phone, roles: ['GUARDIAN'] });
      const login = await otpLogin(h, phone);
      const token = (
        await http(h)
          .post('/auth/switch-tenant')
          .set(bearer(login.accessToken))
          .send({ tenantId: here })
          .expect(200)
      ).body.accessToken as string;
      expect(await rejected(token, 'my KODOM tola school!')).toEqual(['HAS_INSTITUTE_NAME']);
      expect(await rejected(token, 'বকুলকোচিংসেন্টার২০২৬')).toEqual(['HAS_INSTITUTE_NAME']);
      // A distinctive word of either name is enough (P1-I); generic words alone are not.
      expect(await rejected(token, 'kodom@2026 rain')).toEqual(['HAS_INSTITUTE_NAME']);
      expect(await rejected(token, 'বকুল২০২৬১২৩৪৫')).toEqual(['HAS_INSTITUTE_NAME']);
      await passTime(phone, userId);
      const code = await codeFor(token, phone);
      await setPassword(token, code, GOOD).expect(204);
    });

    it('six tries within 15 minutes: the sixth answers 429 with Retry-After', async () => {
      const t = await teacher();
      for (let i = 0; i < 5; i++)
        await setPassword(t.login.accessToken, '123456', GOOD).expect(422);
      const res = await setPassword(t.login.accessToken, '123456', GOOD).expect(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('the code must be 6 digits (400 otherwise)', async () => {
      const t = await teacher();
      await setPassword(t.login.accessToken, '12345', GOOD).expect(400);
      await http(h)
        .put('/me/password')
        .set(bearer(t.login.accessToken))
        .send({ password: GOOD })
        .expect(400);
    });
  });

  describe('other devices are signed out (review focus 3)', () => {
    it('another session stops working; this one, its access token and its refresh, keep working', async () => {
      const t = await teacher();
      await passTime(t.phone, t.userId);
      const other = await otpLogin(h, t.phone); // another device: its own session
      await http(h).get('/auth/me').set(bearer(other.accessToken)).expect(200);

      const code = await codeFor(t.login.accessToken, t.phone);
      await setPassword(t.login.accessToken, code, GOOD).expect(204);

      await http(h).get('/auth/me').set(bearer(other.accessToken)).expect(401);
      await refresh(other.refreshToken!).expect(401);
      const sessions = await withContext(h.prisma, { userId: t.userId }, (tx) =>
        tx.session.findMany({ select: { id: true, revokedAt: true, revokeReason: true } }),
      );
      expect(sessions.filter((s) => s.revokedAt).map((s) => s.revokeReason)).toEqual([
        'PASSWORD_CHANGED',
      ]);
      expect(sessions.filter((s) => !s.revokedAt)).toHaveLength(1);

      await http(h).get('/auth/me').set(bearer(t.login.accessToken)).expect(200);
      const renewed = (await refresh(t.login.refreshToken!).expect(200)).body as AuthResponse;
      await http(h).get('/auth/me').set(bearer(renewed.accessToken)).expect(200);
    });
  });

  it('an expired session is revoked too (a refresh that began before it expired could still extend it)', async () => {
    const t = await teacher();
    await passTime(t.phone, t.userId);
    const old = await otpLogin(h, t.phone);
    const oldSession = (
      await withContext(h.prisma, { userId: t.userId }, (tx) =>
        tx.session.findMany({ where: { revokedAt: null }, orderBy: { createdAt: 'desc' } }),
      )
    )[0]!;
    await withContext(h.prisma, { userId: t.userId }, (tx) =>
      tx.session.update({
        where: { id: oldSession.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      }),
    );
    await refresh(old.refreshToken!).expect(401); // expired: no use

    const code = await codeFor(t.login.accessToken, t.phone);
    await setPassword(t.login.accessToken, code, GOOD).expect(204);
    const after = await withContext(h.prisma, { userId: t.userId }, (tx) =>
      tx.session.findUniqueOrThrow({ where: { id: oldSession.id } }),
    );
    expect(after.revokeReason).toBe('PASSWORD_CHANGED');
    expect(await h.redis.exists(`revoked:sid:${oldSession.id}`)).toBe(1);
  });

  it('never writes the password or the code to the logs', async () => {
    const t = await teacher();
    const writes: string[] = [];
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      }),
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      }),
    ];
    let code = '';
    try {
      code = await codeFor(t.login.accessToken, t.phone);
      await setPassword(t.login.accessToken, code, 'too short').expect(422);
      await setPassword(t.login.accessToken, code, GOOD).expect(204);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const output = writes.join('');
    expect(output).not.toContain(GOOD);
    expect(output).not.toContain('too short');
    expect(output).not.toContain(code);
  });
});

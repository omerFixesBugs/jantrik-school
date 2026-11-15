import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { withContext } from '@jantrik/db';
import type { AuthResponse } from '@jantrik/shared';
import {
  REDIS_TIMEOUT_MS,
  REFRESH_LOCK_WAIT_MS,
  SessionService,
} from '../src/auth/session.service.js';
import { TokenService } from '../src/auth/token.service.js';
import {
  addMember,
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  randomIp,
  type Harness,
} from './support/harness.js';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('refresh tokens: rotation, grace window, reuse detection', () => {
  let h: Harness;
  let tenantId: string;

  beforeAll(async () => {
    h = await createHarness();
    tenantId = (await createTenant(h)).id;
  });

  afterAll(async () => {
    await h.close();
  });

  const refresh = (refreshToken: string) =>
    http(h).post('/auth/refresh').set('X-Forwarded-For', randomIp()).send({ refreshToken });

  async function login(): Promise<AuthResponse & { userId: string }> {
    const { phone, userId } = await addMember(h, tenantId);
    return { ...(await otpLogin(h, phone)), userId };
  }

  async function session(userId: string, accessToken: string) {
    const sid = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString()).sid;
    return withContext(h.prisma, { userId }, (tx) =>
      tx.session.findUniqueOrThrow({ where: { id: sid } }),
    );
  }

  it('rotates: new tokens, keeps the tenant, old access token still valid', async () => {
    const first = await login();
    const res = await refresh(first.refreshToken!).expect(200);
    const second = res.body as AuthResponse;

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.tenant?.id).toBe(tenantId);
    await http(h).get('/auth/me').set(bearer(second.accessToken)).expect(200);
    await refresh(second.refreshToken!).expect(200);
  });

  it('retry within 30 s (replacement unused) returns the same pair', async () => {
    const first = await login();
    const a = (await refresh(first.refreshToken!).expect(200)).body as AuthResponse;
    const b = (await refresh(first.refreshToken!).expect(200)).body as AuthResponse;

    expect(b.refreshToken).toBe(a.refreshToken);
    expect(b.accessToken).toBe(a.accessToken);
    expect((await session(first.userId, a.accessToken)).revokedAt).toBeNull();
    await refresh(a.refreshToken!).expect(200); // the replacement still works
  });

  it('retry after the replacement was used → reuse: whole session revoked', async () => {
    const first = await login();
    const second = (await refresh(first.refreshToken!).expect(200)).body as AuthResponse;
    const third = (await refresh(second.refreshToken!).expect(200)).body as AuthResponse;

    await refresh(first.refreshToken!).expect(401); // replacement already used

    const s = await session(first.userId, third.accessToken);
    expect(s.revokedAt).not.toBeNull();
    expect(s.revokeReason).toBe('REUSE_DETECTED');
    await refresh(third.refreshToken!).expect(401); // newest token dead too
    await http(h).get('/auth/me').set(bearer(third.accessToken)).expect(401); // and access token
  });

  it('retry after the 30 s window → reuse: session revoked', async () => {
    const first = await login();
    const second = (await refresh(first.refreshToken!).expect(200)).body as AuthResponse;

    // Simulate the window passing: grace entry expired, rotation 31 s ago.
    await h.redis.del(`rt:grace:${sha256(first.refreshToken!)}`);
    await withContext(h.prisma, { userId: first.userId }, (tx) =>
      tx.refreshToken.update({
        where: { tokenHash: sha256(first.refreshToken!) },
        data: { rotatedAt: new Date(Date.now() - 31_000) },
      }),
    );

    await refresh(first.refreshToken!).expect(401);
    expect((await session(first.userId, second.accessToken)).revokeReason).toBe('REUSE_DETECTED');
    await refresh(second.refreshToken!).expect(401);
  });

  it('unknown or malformed refresh token → 401', async () => {
    await refresh('x'.repeat(43)).expect(401);
    await http(h).post('/auth/refresh').send({}).expect(401);
  });

  it('logout revokes the session and its access token immediately', async () => {
    const first = await login();
    await http(h).post('/auth/logout').set(bearer(first.accessToken)).expect(204);
    await http(h).get('/auth/me').set(bearer(first.accessToken)).expect(401);
    await refresh(first.refreshToken!).expect(401);
  });

  it('web: refresh token only in an httpOnly Secure SameSite=Strict cookie', async () => {
    const { phone } = await addMember(h, tenantId);
    const ip = randomIp();
    await http(h).post('/auth/otp/request').set('X-Forwarded-For', ip).send({ phone }).expect(202);
    const { waitForOtp } = await import('./support/harness.js');
    const code = await waitForOtp(h, phone);
    const res = await http(h)
      .post('/auth/otp/verify')
      .set('X-Forwarded-For', ip)
      .send({ phone, code, client: 'web' })
      .expect(200);

    expect(res.body.refreshToken).toBeUndefined();
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]!;
    expect(cookie).toMatch(/^jantrik_rt=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/auth/);

    const jar = cookie.split(';')[0]!;
    // Without the client header the cookie is ignored (CSRF defence).
    await http(h).post('/auth/refresh').set('Cookie', jar).send({}).expect(401);
    const ok = await http(h)
      .post('/auth/refresh')
      .set('Cookie', jar)
      .set('X-Jantrik-Client', 'web')
      .send({})
      .expect(200);
    expect(ok.body.refreshToken).toBeUndefined();
    expect(([] as string[]).concat(ok.headers['set-cookie'] ?? [])[0]).toMatch(/^jantrik_rt=/);
  });

  it('stores device info on the session', async () => {
    const { phone, userId } = await addMember(h, tenantId);
    const body = await otpLogin(h, phone);
    const s = await session(userId, body.accessToken);
    expect(s).toMatchObject({ client: 'MOBILE', revokedAt: null });
    expect(s.ip).toMatch(/^10\./);
    expect(s.lastUsedAt).toBeInstanceOf(Date);
  });

  // The race behind the exams e2e sign-out (docs/plans/fix-refresh-race.md): a refresh whose
  // answer the browser lost (a page navigated away) and the next page's refresh with the same
  // old token. Neither may sign the user out or revoke the session.
  describe('two refreshes of the same token', () => {
    const sessions = () => h.app.get(SessionService);

    afterEach(() => {
      vi.restoreAllMocks();
      const s = sessions();
      s.refreshLockWaitMs = REFRESH_LOCK_WAIT_MS;
      s.redisTimeoutMs = REDIS_TIMEOUT_MS;
    });

    /** The answer for retries is stored `ms` later than it would be. */
    function slowAnswer(ms: number) {
      const s = sessions();
      const real = s.storeGrace.bind(s);
      vi.spyOn(s, 'storeGrace').mockImplementation(async (...args) => {
        await sleep(ms);
        return real(...args);
      });
    }

    const rotatedAt = async (userId: string, raw: string) =>
      (
        await withContext(h.prisma, { userId }, (tx) =>
          tx.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha256(raw) } }),
        )
      ).rotatedAt;

    it('a second refresh after the rotation committed gets the same pair; the session lives', async () => {
      const first = await login();
      slowAnswer(300);
      const a = refresh(first.refreshToken!).then((r) => r);
      await vi.waitFor(
        async () => {
          if (!(await rotatedAt(first.userId, first.refreshToken!))) throw new Error('not yet');
        },
        { timeout: 5000, interval: 5 },
      );
      const b = await refresh(first.refreshToken!);
      const ra = await a;
      expect([ra.status, b.status]).toEqual([200, 200]);
      expect(b.body.refreshToken).toBe(ra.body.refreshToken);
      expect((await session(first.userId, first.accessToken)).revokedAt).toBeNull();
    });

    it('two refreshes at once, the first slower than a second: both get the same pair', async () => {
      const first = await login();
      slowAnswer(1500);
      const [ra, rb] = await Promise.all([
        refresh(first.refreshToken!),
        refresh(first.refreshToken!),
      ]);
      expect([ra.status, rb.status]).toEqual([200, 200]);
      expect(rb.body.refreshToken).toBe(ra.body.refreshToken);
      expect((await session(first.userId, first.accessToken)).revokedAt).toBeNull();
    });

    it('natural timing: a second refresh 0-60 ms after the first never signs out', async () => {
      const problems: string[] = [];
      for (let i = 0; i < 26; i++) {
        const delay = (i % 13) * 5;
        const first = await login();
        const a = refresh(first.refreshToken!).then((r) => r);
        if (delay > 0) await sleep(delay);
        const b = await refresh(first.refreshToken!);
        const ra = await a;
        const s = await session(first.userId, first.accessToken);
        if (ra.status !== 200 || b.status !== 200 || s.revokedAt) {
          problems.push(`${delay} ms: ${ra.status}/${b.status} ${s.revokeReason ?? ''}`);
        } else if (ra.body.refreshToken !== b.body.refreshToken) {
          problems.push(`${delay} ms: different pairs`);
        }
      }
      expect(problems).toEqual([]);
    }, 120_000);

    it('a token whose lock stays taken answers 503 REFRESH_BUSY and rotates nothing', async () => {
      const first = await login();
      sessions().refreshLockWaitMs = 200;
      await h.redis.set(`rt:lock:${sha256(first.refreshToken!)}`, 'someone-else', 'PX', 5000);
      const res = await refresh(first.refreshToken!).expect(503);
      expect(res.body.code).toBe('REFRESH_BUSY');
      expect(await rotatedAt(first.userId, first.refreshToken!)).toBeNull();
      await h.redis.del(`rt:lock:${sha256(first.refreshToken!)}`);
      await refresh(first.refreshToken!).expect(200);
    });

    it('leaves no lock behind: after a success, a 401 and an error inside', async () => {
      const first = await login();
      await refresh(first.refreshToken!).expect(200);
      await refresh('y'.repeat(43)).expect(401);
      const other = await login();
      vi.spyOn(h.app.get(TokenService), 'signAccess').mockRejectedValueOnce(new Error('boom'));
      await refresh(other.refreshToken!).expect(500);
      expect(await h.redis.keys('rt:lock:*')).toEqual([]);
    });

    it('a failure while building the answer rotates nothing: the same token then works', async () => {
      const first = await login();
      vi.spyOn(h.app.get(TokenService), 'signAccess').mockRejectedValueOnce(new Error('boom'));
      await refresh(first.refreshToken!).expect(500);
      expect(await rotatedAt(first.userId, first.refreshToken!)).toBeNull();
      await refresh(first.refreshToken!).expect(200);
      expect((await session(first.userId, first.accessToken)).revokedAt).toBeNull();
    });

    describe('Redis unavailable: 503, never a sign-out or a revocation', () => {
      /** Redis `set` fails (or never answers) for keys starting with `prefix`. */
      function breakSet(prefix: string, how: 'fail' | 'hang') {
        const real = h.redis.set.bind(h.redis);
        vi.spyOn(h.redis, 'set').mockImplementation(((key: string, ...rest: unknown[]) =>
          key.startsWith(prefix)
            ? how === 'fail'
              ? Promise.reject(new Error('Connection is closed.'))
              : new Promise(() => undefined)
            : (real as (...a: unknown[]) => Promise<unknown>)(key, ...rest)) as never);
      }

      it('the lock cannot be taken (error): 503 REFRESH_UNAVAILABLE, nothing rotated', async () => {
        const first = await login();
        breakSet('rt:lock:', 'fail');
        const res = await refresh(first.refreshToken!).expect(503);
        expect(res.body.code).toBe('REFRESH_UNAVAILABLE');
        expect(await rotatedAt(first.userId, first.refreshToken!)).toBeNull();
        vi.restoreAllMocks();
        await refresh(first.refreshToken!).expect(200);
      });

      it('Redis does not answer: 503 REFRESH_UNAVAILABLE after the time limit', async () => {
        const first = await login();
        sessions().redisTimeoutMs = 200;
        breakSet('rt:lock:', 'hang');
        const started = Date.now();
        const res = await refresh(first.refreshToken!).expect(503);
        expect(res.body.code).toBe('REFRESH_UNAVAILABLE');
        expect(Date.now() - started).toBeLessThan(5000);
        expect(await rotatedAt(first.userId, first.refreshToken!)).toBeNull();
      });

      it('the answer cannot be stored: 503, nothing rotated, the same token then works', async () => {
        const first = await login();
        breakSet('rt:grace:', 'fail');
        await refresh(first.refreshToken!).expect(503);
        expect(await rotatedAt(first.userId, first.refreshToken!)).toBeNull();
        vi.restoreAllMocks();
        await refresh(first.refreshToken!).expect(200);
        expect((await session(first.userId, first.accessToken)).revokedAt).toBeNull();
      });

      it('a retry cannot read the stored answer: 503, no revocation; later it gets the pair', async () => {
        const first = await login();
        const a = (await refresh(first.refreshToken!).expect(200)).body as AuthResponse;
        const real = h.redis.get.bind(h.redis);
        vi.spyOn(h.redis, 'get').mockImplementation(((key: string) =>
          key.startsWith('rt:grace:')
            ? Promise.reject(new Error('Connection is closed.'))
            : real(key)) as never);
        await refresh(first.refreshToken!).expect(503);
        expect((await session(first.userId, first.accessToken)).revokedAt).toBeNull();
        vi.restoreAllMocks();
        const again = (await refresh(first.refreshToken!).expect(200)).body as AuthResponse;
        expect(again.refreshToken).toBe(a.refreshToken);
      });
    });

    describe('the stored answer (condition 1)', () => {
      it('lives at most 30 s, under the old token hash, and holds no token in clear', async () => {
        const first = await login();
        const a = (await refresh(first.refreshToken!).expect(200)).body as AuthResponse;
        const key = `rt:grace:${sha256(first.refreshToken!)}`;
        const ttl = await h.redis.ttl(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(30);
        const keys = await h.redis.keys('*');
        for (const raw of [first.refreshToken!, a.refreshToken!]) {
          expect(keys.some((k) => k.includes(raw))).toBe(false);
        }
        const sealed = (await h.redis.get(key))!;
        for (const secret of [a.refreshToken!, a.accessToken]) {
          expect(sealed).not.toContain(secret);
          expect(Buffer.from(sealed, 'base64').toString('latin1')).not.toContain(secret);
        }
      });

      it("is never given for another session's token, even when copied under its key", async () => {
        const one = await login();
        const two = await login();
        const oneAnswer = (await refresh(one.refreshToken!).expect(200)).body as AuthResponse;
        await refresh(two.refreshToken!).expect(200);
        // Session one's stored answer, copied under session two's old-token key.
        const sealed = (await h.redis.get(`rt:grace:${sha256(one.refreshToken!)}`))!;
        await h.redis.set(`rt:grace:${sha256(two.refreshToken!)}`, sealed, 'EX', 30);
        const res = await refresh(two.refreshToken!);
        expect(res.body.refreshToken).not.toBe(oneAnswer.refreshToken);
        expect(res.body.accessToken).toBeUndefined();
      });
    });
  });
});

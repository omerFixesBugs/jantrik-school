import { createHash } from 'node:crypto';
import { withContext } from '@jantrik/db';
import type { AuthResponse } from '@jantrik/shared';
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
});

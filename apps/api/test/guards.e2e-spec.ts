import { JwtService } from '@nestjs/jwt';
import {
  addMember,
  bearer,
  createHarness,
  createTenant,
  http,
  otpLogin,
  randomPhone,
  type Harness,
} from './support/harness.js';
import { platform, platformAdminCookie } from './support/platform.js';

describe('guards and request side effects', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('missing, malformed, forged or expired token → 401', async () => {
    await http(h).get('/auth/me').expect(401);
    await http(h).get('/auth/me').set(bearer('not-a-jwt')).expect(401);

    const forged = await new JwtService({
      secret: 'some-other-secret-0123456789abcdefghij',
    }).signAsync(
      { sub: crypto.randomUUID(), sid: crypto.randomUUID(), typ: 'access' },
      { issuer: 'jantrik-api', audience: 'jantrik' },
    );
    await http(h).get('/auth/me').set(bearer(forged)).expect(401);

    const expired = await h.app
      .get(JwtService)
      .signAsync(
        { sub: crypto.randomUUID(), sid: crypto.randomUUID(), typ: 'access' },
        { issuer: 'jantrik-api', audience: 'jantrik', expiresIn: -10 },
      );
    await http(h).get('/auth/me').set(bearer(expired)).expect(401);
  });

  it('@Roles blocks a TEACHER and allows an ADMIN', async () => {
    const t = await createTenant(h);
    const teacher = await otpLogin(h, (await addMember(h, t.id, { roles: ['TEACHER'] })).phone);
    const admin = await otpLogin(h, (await addMember(h, t.id, { roles: ['ADMIN'] })).phone);
    await http(h).get('/test/admin-only').set(bearer(teacher.accessToken)).expect(403);
    await http(h).get('/test/admin-only').set(bearer(admin.accessToken)).expect(200);
  });

  it('a role downgrade applies on the next request, without re-login', async () => {
    const t = await createTenant(h);
    const { phone, userId } = await addMember(h, t.id, { roles: ['ADMIN'] });
    const login = await otpLogin(h, phone);
    await http(h).get('/test/admin-only').set(bearer(login.accessToken)).expect(200); // cached

    await h.access.setMemberRoles(t.id, userId, ['TEACHER']);

    await http(h).get('/test/admin-only').set(bearer(login.accessToken)).expect(403);
  });

  it('@Roles needs a selected tenant', async () => {
    const a = await createTenant(h);
    const b = await createTenant(h);
    const phone = randomPhone();
    await addMember(h, a.id, { phone, roles: ['ADMIN'] });
    await addMember(h, b.id, { phone, roles: ['ADMIN'] });
    const login = await otpLogin(h, phone); // two tenants: none selected
    await http(h).get('/test/admin-only').set(bearer(login.accessToken)).expect(403);
  });

  it('@RequireModule blocks a disabled module; enabling it applies immediately', async () => {
    const t = await createTenant(h, { modules: [] });
    const login = await otpLogin(h, (await addMember(h, t.id)).phone);
    await http(h).get('/test/attendance').set(bearer(login.accessToken)).expect(403); // now cached

    // Only the platform switches modules (the institute's own role cannot).
    const cookie = await platformAdminCookie(h);
    const setAttendance = (enabled: boolean) =>
      platform(h, cookie)
        .put(`/platform/institutes/${t.id}/modules/ATTENDANCE`)
        .send({ enabled })
        .expect(200);
    await setAttendance(true);
    await http(h).get('/test/attendance').set(bearer(login.accessToken)).expect(200);

    await setAttendance(false);
    await http(h).get('/test/attendance').set(bearer(login.accessToken)).expect(403);
  });

  it('afterCommit: an SMS queued by a handler that then fails is never sent', async () => {
    const t = await createTenant(h);
    const login = await otpLogin(h, (await addMember(h, t.id)).phone);
    const target = randomPhone();

    await http(h)
      .post('/test/sms-then-fail')
      .set(bearer(login.accessToken))
      .send({ phone: target })
      .expect(400);
    await http(h)
      .post('/test/sms-ok')
      .set(bearer(login.accessToken))
      .send({ phone: target })
      .expect(201);

    // The successful request's SMS arrives; the failed one's never does.
    await vi.waitFor(() => expect(h.sms.sentTo(target)).toEqual(['arrives after commit']));
    await new Promise((r) => setTimeout(r, 300));
    expect(h.sms.sentTo(target)).toEqual(['arrives after commit']);
  });

  it('authenticated requests are limited per user, not per IP', async () => {
    const t = await createTenant(h);
    const { phone, userId } = await addMember(h, t.id);
    const login = await otpLogin(h, phone);
    await h.redis.set(`rl:req-user:${userId}`, 300, 'EX', 60);
    await http(h).get('/auth/me').set(bearer(login.accessToken)).expect(429);

    // Another user behind the same IP is unaffected.
    const other = await otpLogin(h, (await addMember(h, t.id)).phone);
    await http(h).get('/auth/me').set(bearer(other.accessToken)).expect(200);
  });
});

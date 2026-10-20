import type { AuthResponse, MembershipSummary } from '@jantrik/shared';
import {
  addMember,
  bearer,
  createHarness,
  createStudent,
  createTenant,
  http,
  otpLogin,
  randomPhone,
  type Harness,
} from './support/harness.js';
import { platform, platformAdminCookie } from './support/platform.js';

describe('tenant selection and per-request tenant context', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  const switchTo = (token: string, tenantId: string) =>
    http(h).post('/auth/switch-tenant').set(bearer(token)).send({ tenantId });

  it('two memberships: no auto-switch; memberships listed; switch issues a scoped token', async () => {
    const a = await createTenant(h);
    const b = await createTenant(h);
    const phone = randomPhone();
    await addMember(h, a.id, { phone, roles: ['ADMIN'] });
    await addMember(h, b.id, { phone, roles: ['TEACHER', 'ACCOUNTANT'] });

    const login = await otpLogin(h, phone);
    expect(login.tenant).toBeUndefined();

    const list = (await http(h).get('/auth/memberships').set(bearer(login.accessToken)).expect(200))
      .body as MembershipSummary[];
    expect(list.map((m) => m.tenant.id).sort()).toEqual([a.id, b.id].sort());
    expect(list.find((m) => m.tenant.id === b.id)?.roles.sort()).toEqual(['ACCOUNTANT', 'TEACHER']);

    const switched = await switchTo(login.accessToken, b.id).expect(200);
    expect(switched.body).toMatchObject({ tenant: { id: b.id }, expiresIn: 900 });
    const me = await http(h).get('/auth/me').set(bearer(switched.body.accessToken)).expect(200);
    expect(me.body.tenant.id).toBe(b.id);

    // Refresh keeps the selected tenant.
    const refreshed = (
      await http(h).post('/auth/refresh').send({ refreshToken: login.refreshToken }).expect(200)
    ).body as AuthResponse;
    expect(refreshed.tenant?.id).toBe(b.id);
  });

  it('cannot switch to a tenant without a membership', async () => {
    const mine = await createTenant(h);
    const other = await createTenant(h);
    const { phone } = await addMember(h, mine.id);
    const login = await otpLogin(h, phone);
    await switchTo(login.accessToken, other.id).expect(403);
  });

  it('cannot switch to a SUSPENDED tenant (and it is not auto-selected)', async () => {
    const suspended = await createTenant(h, { status: 'SUSPENDED' });
    const active = await createTenant(h);
    const phone = randomPhone();
    await addMember(h, suspended.id, { phone });
    await addMember(h, active.id, { phone });

    const login = await otpLogin(h, phone);
    expect(login.tenant?.id).toBe(active.id); // only selectable one
    await switchTo(login.accessToken, suspended.id).expect(403);
  });

  it("tenant A's token cannot see tenant B's data", async () => {
    const a = await createTenant(h);
    const b = await createTenant(h);
    const studentA = await createStudent(h, a.id, 'A-1');
    const studentB = await createStudent(h, b.id, 'B-1');
    const { phone } = await addMember(h, a.id);
    const login = await otpLogin(h, phone);
    expect(login.tenant?.id).toBe(a.id);

    const list = await http(h).get('/test/students').set(bearer(login.accessToken)).expect(200);
    expect(list.body).toEqual([{ id: studentA.id, tenantId: a.id, studentCode: 'A-1' }]);
    await http(h).get(`/test/students/${studentB.id}`).set(bearer(login.accessToken)).expect(404);
    await http(h).get(`/test/students/${studentA.id}`).set(bearer(login.accessToken)).expect(200);
  });

  it('suspending the tenant blocks tenant requests immediately, account routes still work', async () => {
    const t = await createTenant(h);
    const { phone } = await addMember(h, t.id);
    const login = await otpLogin(h, phone);
    await http(h).get('/test/students').set(bearer(login.accessToken)).expect(200);

    // Only the platform suspends (the institute's own role cannot change its status).
    await platform(h, await platformAdminCookie(h))
      .post(`/platform/institutes/${t.id}/suspend`)
      .send({ reason: 'test suspension' })
      .expect(200);

    await http(h).get('/test/students').set(bearer(login.accessToken)).expect(403);
    await http(h).get('/auth/me').set(bearer(login.accessToken)).expect(200);
    await http(h).post('/auth/logout').set(bearer(login.accessToken)).expect(204);
  });

  it('a token without a tenant has no tenant data', async () => {
    const a = await createTenant(h);
    const b = await createTenant(h);
    const phone = randomPhone();
    await addMember(h, a.id, { phone });
    await addMember(h, b.id, { phone });
    await createStudent(h, a.id, 'A-1');
    const login = await otpLogin(h, phone);
    expect(login.tenant).toBeUndefined();
    const list = await http(h).get('/test/students').set(bearer(login.accessToken)).expect(200);
    expect(list.body).toEqual([]);
  });
});

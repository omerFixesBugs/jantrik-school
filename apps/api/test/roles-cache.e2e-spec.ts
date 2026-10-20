import { PrismaService } from '../src/prisma/prisma.service.js';
import { rolesKey, rolesVersionKey } from '../src/tenancy/tenant-access.service.js';
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

// Decision #16: the roles cache is versioned per member. A request that loaded the old roles just
// before a change committed may write them back after it; that write lands under the old version
// and is never read, so the change applies on the very next request.
describe('roles cache versioning', () => {
  let h: Harness;
  let tenantId: string;
  let owner: string;

  const version = async (userId: string) =>
    Number((await h.redis.get(rolesVersionKey(tenantId, userId))) ?? '0');
  /** What a racing reader (version read before the change, roles loaded before it) writes. */
  const staleWrite = async (userId: string, v: number, roles: string[]) =>
    h.redis.set(rolesKey(tenantId, userId, String(v)), JSON.stringify(roles), 'EX', 300);
  const adminOnly = (token: string) => http(h).get('/test/admin-only').set(bearer(token));
  const guardianOnly = (token: string) => http(h).get('/me/children').set(bearer(token));

  beforeAll(async () => {
    h = await createHarness();
    tenantId = (await createTenant(h)).id;
    owner = (await otpLogin(h, (await addMember(h, tenantId, { roles: ['OWNER'] })).phone))
      .accessToken;
  });

  afterAll(async () => {
    await h.close();
  });

  it('a demoted admin who is also a guardian loses ADMIN on the next request, despite a stale write', async () => {
    const m = await addMember(h, tenantId, { roles: ['ADMIN', 'GUARDIAN'] });
    const token = (await otpLogin(h, m.phone)).accessToken;
    await adminOnly(token).expect(200); // cached
    const before = await version(m.userId);

    await http(h)
      .put(`/staff/${m.userId}/roles`)
      .set(bearer(owner))
      .send({ roles: ['TEACHER'] })
      .expect(200);
    expect(await version(m.userId)).toBeGreaterThan(before);
    await staleWrite(m.userId, before, ['ADMIN', 'GUARDIAN']);

    await adminOnly(token).expect(403);
    await guardianOnly(token).expect(200);
  });

  it('the real race: a request that loaded ADMIN just before the demotion commits cannot re-cache it', async () => {
    const m = await addMember(h, tenantId, { roles: ['ADMIN', 'GUARDIAN'] });
    const token = (await otpLogin(h, m.phone)).accessToken;
    // Login cached the roles; start from a cold cache so the next request's guard loads them.
    await h.redis.incr(rolesVersionKey(tenantId, m.userId));
    // Pause the next transaction (the guard's roles load) after it finished, before its cache
    // write, until the demotion has committed and bumped the version.
    const client = h.app.get(PrismaService).client;
    const original = client.$transaction.bind(client) as (...a: unknown[]) => Promise<unknown>;
    let loaded!: () => void;
    let release!: () => void;
    const isLoaded = new Promise<void>((r) => (loaded = r));
    const released = new Promise<void>((r) => (release = r));
    let armed = true;
    const spy = vi.spyOn(client, '$transaction').mockImplementation((async (...args: unknown[]) => {
      if (!armed) return original(...args);
      armed = false;
      const result = await original(...args);
      loaded();
      await released;
      return result;
    }) as never);
    try {
      const racing = adminOnly(token).then((r) => r.status); // authorised with the old roles
      await isLoaded;
      await http(h)
        .put(`/staff/${m.userId}/roles`)
        .set(bearer(owner))
        .send({ roles: ['TEACHER'] })
        .expect(200);
      release();
      expect(await racing).toBe(200);
    } finally {
      spy.mockRestore();
    }
    await adminOnly(token).expect(403);
    await guardianOnly(token).expect(200);
  });

  it('a deactivated admin who is also a guardian keeps only guardian access, despite a stale write', async () => {
    const m = await addMember(h, tenantId, { roles: ['ADMIN', 'GUARDIAN'] });
    const token = (await otpLogin(h, m.phone)).accessToken;
    await adminOnly(token).expect(200);
    const before = await version(m.userId);

    await http(h).post(`/staff/${m.userId}/deactivate`).set(bearer(owner)).expect(200);
    await staleWrite(m.userId, before, ['ADMIN', 'GUARDIAN']);

    await adminOnly(token).expect(403);
    await guardianOnly(token).expect(200);
  });

  it('a demoted admin (staff only) loses ADMIN on the next request, despite a stale write', async () => {
    const m = await addMember(h, tenantId, { roles: ['ADMIN'] });
    const token = (await otpLogin(h, m.phone)).accessToken;
    await adminOnly(token).expect(200);
    const before = await version(m.userId);

    await http(h)
      .put(`/staff/${m.userId}/roles`)
      .set(bearer(owner))
      .send({ roles: ['TEACHER'] })
      .expect(200);
    await staleWrite(m.userId, before, ['ADMIN']);

    await adminOnly(token).expect(403);
  });

  it('every membership change bumps the version: invite, decline, re-invite, accept, cancel', async () => {
    const phone = randomPhone();
    const invited = (
      await http(h)
        .post('/staff')
        .set(bearer(owner))
        .send({ phone, name: 'Invitee', roles: ['TEACHER'] })
        .expect(201)
    ).body as { userId: string };
    const seen = [0]; // a new person: no version yet
    const step = async () => {
      const v = await version(invited.userId);
      expect(v).toBeGreaterThan(seen.at(-1)!);
      seen.push(v);
    };
    await step(); // the invitation itself (added rows)

    const login = await otpLogin(h, phone);
    await http(h)
      .post(`/me/invitations/${tenantId}/decline`)
      .set(bearer(login.accessToken))
      .expect(204);
    await step();
    await http(h).post(`/staff/${invited.userId}/reinvite`).set(bearer(owner)).expect(200);
    await step();
    await http(h)
      .post(`/me/invitations/${tenantId}/accept`)
      .set(bearer(login.accessToken))
      .send({ roles: ['TEACHER'] })
      .expect(204);
    await step();

    const other = (
      await http(h)
        .post('/staff')
        .set(bearer(owner))
        .send({ phone: randomPhone(), name: 'Wrong Number', roles: ['STAFF'] })
        .expect(201)
    ).body as { userId: string };
    const v = await version(other.userId);
    await http(h).post(`/staff/${other.userId}/cancel-invitation`).set(bearer(owner)).expect(204);
    expect(await version(other.userId)).toBeGreaterThan(v);
  });
});

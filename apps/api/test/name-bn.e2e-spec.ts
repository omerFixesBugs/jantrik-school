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

const PASSWORD = 'Correct-Horse-9';

/** users.name_bn reaches the client on every path that returns the user. */
describe('users.name_bn in auth responses', () => {
  let h: Harness;
  let tenantId: string;

  beforeAll(async () => {
    h = await createHarness();
    tenantId = (await createTenant(h)).id;
  });

  afterAll(async () => {
    await h.close();
  });

  /** A member with a Bangla name, set as that user (users RLS: update yourself only). */
  async function member(nameBn: string | null) {
    const m = await addMember(h, tenantId, { password: PASSWORD, name: 'Rahima Khatun' });
    await withContext(h.prisma, { userId: m.userId }, (tx) =>
      tx.user.update({ where: { id: m.userId }, data: { nameBn } }),
    );
    return m;
  }

  it('password login, refresh and /auth/me return nameBn', async () => {
    const { phone } = await member('রহিমা খাতুন');
    const login = (
      await http(h)
        .post('/auth/login')
        .set('X-Forwarded-For', randomIp())
        .send({ identifier: phone, password: PASSWORD, client: 'mobile' })
        .expect(200)
    ).body as AuthResponse;
    expect(login.user).toMatchObject({ name: 'Rahima Khatun', nameBn: 'রহিমা খাতুন' });

    const refreshed = (
      await http(h)
        .post('/auth/refresh')
        .set('X-Forwarded-For', randomIp())
        .send({ refreshToken: login.refreshToken })
        .expect(200)
    ).body as AuthResponse;
    expect(refreshed.user.nameBn).toBe('রহিমা খাতুন');

    const me = await http(h).get('/auth/me').set(bearer(refreshed.accessToken)).expect(200);
    expect(me.body.user).toMatchObject({ name: 'Rahima Khatun', nameBn: 'রহিমা খাতুন' });
  });

  it('OTP login returns nameBn', async () => {
    const { phone } = await member('রহিমা খাতুন');
    expect((await otpLogin(h, phone)).user.nameBn).toBe('রহিমা খাতুন');
  });

  it('nameBn is null when not set', async () => {
    const { phone } = await member(null);
    expect((await otpLogin(h, phone)).user).toMatchObject({ name: 'Rahima Khatun', nameBn: null });
  });
});

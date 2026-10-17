import {
  addMember,
  createHarness,
  createTenant,
  http,
  randomIp,
  randomPhone,
  waitForOtp,
  type Harness,
} from './support/harness.js';

describe('OTP login', () => {
  let h: Harness;
  let tenantId: string;

  beforeAll(async () => {
    h = await createHarness();
    tenantId = (await createTenant(h)).id;
  });

  afterAll(async () => {
    await h.close();
  });

  const request = (phone: string, ip = randomIp()) =>
    http(h).post('/auth/otp/request').set('X-Forwarded-For', ip).send({ phone });
  const verify = (phone: string, code: string, ip = randomIp()) =>
    http(h)
      .post('/auth/otp/verify')
      .set('X-Forwarded-For', ip)
      .send({ phone, code, client: 'mobile' });
  /** Simulate the per-phone cooldown / 15-minute windows passing. */
  const passTime = (phone: string) =>
    h.redis.del(`rl:otp-phone-cooldown:${phone}`, `rl:otp-phone-15m:${phone}`);

  it('correct code logs in (accepting a local 01… number) and auto-selects the only tenant', async () => {
    const { phone, userId } = await addMember(h, tenantId);
    await request(`0${phone.slice(4)}`).expect(202, { expiresIn: 300 });
    const code = await waitForOtp(h, phone);

    const res = await verify(phone, code).expect(200);
    expect(res.body).toMatchObject({
      user: { id: userId },
      tenant: { id: tenantId },
      roles: ['TEACHER'],
      expiresIn: 900,
    });
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
  });

  it('a code is single-use', async () => {
    const { phone } = await addMember(h, tenantId);
    await request(phone).expect(202);
    const code = await waitForOtp(h, phone);
    await verify(phone, code).expect(200);
    await verify(phone, code).expect(401);
  });

  it('wrong code → generic 401', async () => {
    const { phone } = await addMember(h, tenantId);
    await request(phone).expect(202);
    const code = await waitForOtp(h, phone);
    const wrong = code === '000000' ? '111111' : '000000';
    const res = await verify(phone, wrong).expect(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('after 5 wrong attempts the code is burned, even the right code fails', async () => {
    const { phone } = await addMember(h, tenantId);
    await request(phone).expect(202);
    const code = await waitForOtp(h, phone);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await verify(phone, wrong).expect(401);
    await verify(phone, code).expect(401);
  });

  it('expired code fails', async () => {
    const { phone } = await addMember(h, tenantId);
    await request(phone).expect(202);
    const code = await waitForOtp(h, phone);
    await h.redis.pexpire(`otp:${phone}`, 1);
    await new Promise((r) => setTimeout(r, 20));
    await verify(phone, code).expect(401);
  });

  it('per-phone cooldown → 429 with Retry-After', async () => {
    const { phone } = await addMember(h, tenantId);
    await request(phone).expect(202);
    const res = await request(phone).expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('caps SMS per phone per day (10)', async () => {
    const { phone } = await addMember(h, tenantId);
    for (let i = 0; i < 10; i++) {
      await passTime(phone);
      await request(phone).expect(202);
    }
    await passTime(phone);
    await request(phone).expect(429);
    await vi.waitFor(() => expect(h.sms.sentTo(phone)).toHaveLength(10));
  });

  it('per-IP limit is high but enforced (200/hour)', async () => {
    const ip = randomIp();
    await h.redis.set(`rl:otp-ip:${ip}`, 200, 'EX', 3600);
    await request(randomPhone(), ip).expect(429);
  });

  it('unknown phone: same response, no SMS; verify fails generically', async () => {
    const phone = randomPhone();
    const res = await request(phone).expect(202);
    expect(res.body).toEqual({ expiresIn: 300 });
    await new Promise((r) => setTimeout(r, 300));
    expect(h.sms.sentTo(phone)).toEqual([]);
    const fail = await verify(phone, '123456').expect(401);
    expect(fail.body.message).toBe('Invalid credentials');
  });

  it('invalid phone format → 400 without echoing input', async () => {
    const res = await request('12345').expect(400);
    expect(JSON.stringify(res.body)).not.toContain('12345');
  });
});

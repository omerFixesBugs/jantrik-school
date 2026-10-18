import { withContext } from '@jantrik/db';
import {
  addMember,
  createHarness,
  createTenant,
  http,
  randomIp,
  randomPhone,
  type Harness,
} from './support/harness.js';

const PASSWORD = 'correct horse battery staple';

describe('password login', () => {
  let h: Harness;
  let tenantId: string;

  beforeAll(async () => {
    h = await createHarness();
    tenantId = (await createTenant(h)).id;
  });

  afterAll(async () => {
    await h.close();
  });

  const login = (identifier: string, password: string, ip = randomIp()) =>
    http(h)
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ identifier, password, client: 'mobile' });

  it('logs in with phone + password; stored hash is argon2id', async () => {
    const { phone, userId } = await addMember(h, tenantId, {
      roles: ['ADMIN'],
      password: PASSWORD,
    });
    const res = await login(phone, PASSWORD).expect(200);
    expect(res.body).toMatchObject({
      user: { id: userId },
      tenant: { id: tenantId },
      roles: ['ADMIN'],
    });

    const user = await withContext(h.prisma, { userId }, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('wrong password, unknown user and OTP-only user get the identical response', async () => {
    const { phone } = await addMember(h, tenantId, { password: PASSWORD });
    const { phone: otpOnly } = await addMember(h, tenantId);

    const wrong = await login(phone, 'nope').expect(401);
    const unknown = await login(randomPhone(), PASSWORD).expect(401);
    const noPassword = await login(otpOnly, PASSWORD).expect(401);
    const unknownEmail = await login('nobody@example.com', PASSWORD).expect(401);

    expect(wrong.body).toEqual({
      statusCode: 401,
      message: 'Invalid credentials',
      error: 'Unauthorized',
    });
    expect(unknown.body).toEqual(wrong.body);
    expect(noPassword.body).toEqual(wrong.body);
    expect(unknownEmail.body).toEqual(wrong.body);
  });

  it('limits failed attempts per identifier (5 / 15 min), across IPs', async () => {
    const { phone } = await addMember(h, tenantId, { password: PASSWORD });
    for (let i = 0; i < 5; i++) await login(phone, 'nope').expect(401);
    await login(phone, PASSWORD).expect(429); // even the right password, once locked
  });

  it('a successful login resets the failed attempts', async () => {
    const { phone } = await addMember(h, tenantId, { password: PASSWORD });
    for (let i = 0; i < 4; i++) await login(phone, 'nope').expect(401);
    await login(phone, PASSWORD).expect(200);
    for (let i = 0; i < 5; i++) await login(phone, 'nope').expect(401); // 5 more allowed
    await login(phone, 'nope').expect(429);
  });

  it('successful logins never hit the per-account limit', async () => {
    const { phone } = await addMember(h, tenantId, { password: PASSWORD });
    for (let i = 0; i < 8; i++) await login(phone, PASSWORD).expect(200);
  });

  it('the per-IP limit still counts every attempt, successful ones too', async () => {
    const { phone } = await addMember(h, tenantId, { password: PASSWORD });
    const ip = randomIp();
    await login(phone, PASSWORD, ip).expect(200);
    await login(phone, PASSWORD, ip).expect(200);
    await login(phone, 'nope', ip).expect(401);
    expect(await h.redis.get(`rl:login-ip:${ip}`)).toBe('3');
    expect(await h.redis.get(`rl:login-id:${phone}`)).toBe('1'); // only the failure since
  });

  it('never writes the password or code to the logs', async () => {
    const { phone } = await addMember(h, tenantId, { password: PASSWORD });
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
    try {
      await login(phone, PASSWORD).expect(200);
      await login(phone, 'wrong-secret-pass').expect(401);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const output = writes.join('');
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain('wrong-secret-pass');
  });
});

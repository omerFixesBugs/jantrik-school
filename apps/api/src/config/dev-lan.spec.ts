import { isAllowedOrigin, isPrivateLanOrigin, refreshCookieSecure } from './dev-lan.js';
import { envSchema } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://x@localhost/jantrik',
  DATABASE_PLATFORM_URL: 'postgresql://p@localhost/jantrik',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  OTP_PEPPER: 'y'.repeat(40),
};

describe('env: loosened settings never leave development', () => {
  it('DEV_LAN is accepted only in development', () => {
    expect(envSchema.safeParse({ ...base, NODE_ENV: 'development', DEV_LAN: 'true' }).success).toBe(
      true,
    );
    for (const NODE_ENV of ['test', 'production']) {
      const result = envSchema.safeParse({ ...base, NODE_ENV, DEV_LAN: 'true' });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error)).toContain('DEV_LAN');
    }
  });

  it('a fixed test date (JANTRIK_TEST_TODAY) is accepted only in tests, and only a real date', () => {
    expect(
      envSchema.safeParse({ ...base, NODE_ENV: 'test', JANTRIK_TEST_TODAY: '2026-10-21' }).success,
    ).toBe(true);
    for (const NODE_ENV of ['development', 'production']) {
      const result = envSchema.safeParse({
        ...base,
        NODE_ENV,
        PLATFORM_TOTP_KEY: 'k'.repeat(32),
        JANTRIK_TEST_TODAY: '2026-10-21',
      });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error)).toContain('JANTRIK_TEST_TODAY');
    }
    const bad = envSchema.safeParse({
      ...base,
      NODE_ENV: 'test',
      JANTRIK_TEST_TODAY: '2026-02-30',
    });
    expect(bad.success).toBe(false);
  });

  it('COOKIE_SECURE=false is refused in production', () => {
    const prod = { ...base, NODE_ENV: 'production', PLATFORM_TOTP_KEY: 'k'.repeat(32) };
    const result = envSchema.safeParse({ ...prod, COOKIE_SECURE: 'false' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain('COOKIE_SECURE');
    expect(envSchema.safeParse(prod).success).toBe(true);
  });

  it('PLATFORM_TOTP_KEY is required in production only', () => {
    const result = envSchema.safeParse({ ...base, NODE_ENV: 'production' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain('PLATFORM_TOTP_KEY');
    expect(envSchema.safeParse({ ...base, NODE_ENV: 'development' }).success).toBe(true);
    const short = envSchema.safeParse({ ...base, NODE_ENV: 'production', PLATFORM_TOTP_KEY: 'x' });
    expect(short.success).toBe(false);
  });

  it('DEV_LAN is off by default', () => {
    expect(envSchema.parse({ ...base, NODE_ENV: 'development' }).DEV_LAN).toBe(false);
  });
});

describe('LAN origins', () => {
  it.each([
    ['http://192.168.0.200:3000', true],
    ['http://10.0.0.5:3000', true],
    ['http://172.16.4.2:3000', true],
    ['http://172.31.255.1:3000', true],
    ['http://172.32.0.1:3000', false], // outside 172.16.0.0/12
    ['http://192.168.0.200:4000', false], // only the web dev port
    ['https://192.168.0.200:3000', false],
    ['http://8.8.8.8:3000', false],
    ['http://evil.example.com:3000', false],
    ['http://192.168.0.200.evil.com:3000', false],
    ['not a url', false],
  ])('%s → %s', (origin, ok) => {
    expect(isPrivateLanOrigin(origin)).toBe(ok);
  });
});

describe('CORS', () => {
  const env = (NODE_ENV: 'development' | 'test' | 'production', DEV_LAN: boolean) => ({
    NODE_ENV,
    DEV_LAN,
    CORS_ORIGINS: ['http://localhost:3000'],
  });

  it('the allowlist always works', () => {
    expect(isAllowedOrigin('http://localhost:3000', env('production', false))).toBe(true);
    expect(isAllowedOrigin('http://localhost:3000', env('development', true))).toBe(true);
  });

  it('a LAN origin only in development with DEV_LAN', () => {
    expect(isAllowedOrigin('http://192.168.0.200:3000', env('development', true))).toBe(true);
    expect(isAllowedOrigin('http://192.168.0.200:3000', env('development', false))).toBe(false);
    // Validation refuses DEV_LAN outside development; even if it got through, it does nothing.
    expect(isAllowedOrigin('http://192.168.0.200:3000', env('production', true))).toBe(false);
    expect(isAllowedOrigin('http://192.168.0.200:3000', env('test', true))).toBe(false);
  });

  it('public origins never', () => {
    expect(isAllowedOrigin('https://evil.example.com', env('development', true))).toBe(false);
  });
});

describe('refresh cookie Secure flag', () => {
  it('off only in development with DEV_LAN', () => {
    expect(
      refreshCookieSecure({ NODE_ENV: 'development', DEV_LAN: true, COOKIE_SECURE: true }),
    ).toBe(false);
    expect(
      refreshCookieSecure({ NODE_ENV: 'development', DEV_LAN: false, COOKIE_SECURE: true }),
    ).toBe(true);
    expect(
      refreshCookieSecure({ NODE_ENV: 'production', DEV_LAN: true, COOKIE_SECURE: true }),
    ).toBe(true);
  });
});

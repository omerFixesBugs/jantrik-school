import { readFileSync } from 'node:fs';
import path from 'node:path';
import { envSchema, validateEnv } from './env.js';
import { validateIngestEnv } from './ingest-env.js';
import {
  API_ONLY_SECRETS,
  DATABASE_ADMIN_SECRETS,
  trustsAnyClient,
  unsafeOrigin,
} from './production-env.js';

// Every production rule (docs/deploy.md → Environment checks): refused in production, and the
// same settings still accepted where development and the tests use them.

/** A complete production API (and worker) environment. */
const api = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://jantrik_app:pw@db:5432/jantrik',
  DATABASE_PLATFORM_URL: 'postgresql://jantrik_platform_app:pw@db:5432/jantrik',
  REDIS_URL: `redis://:${'f3'.repeat(24)}@redis:6379`,
  TRUST_PROXY: '1',
  CORS_ORIGINS: 'https://app.jantrik.com.bd,https://platform.jantrik.com.bd',
  JWT_ACCESS_SECRET: 'q7Hk'.repeat(10),
  OTP_PEPPER: 'w3Zp'.repeat(10),
  PLATFORM_TOTP_KEY: 'e5Rt'.repeat(10),
  SMS_PROVIDER: 'none',
  INGEST_PUBLIC_HOST: 'devices.jantrik.com.bd',
};

/** A complete production receiver environment: its own variables only. */
const receiver = {
  NODE_ENV: 'production',
  DATABASE_INGEST_URL: 'postgresql://jantrik_ingest_app:pw@db:5432/jantrik',
  REDIS_URL: `redis://:${'f3'.repeat(24)}@redis:6379`,
  QUEUE_PREFIX: 'jantrik',
};

/** validateEnv's error for `env`, or '' when it starts. */
const apiError = (env: Record<string, string | undefined>): string => {
  try {
    validateEnv(env);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
};

const receiverError = (env: Record<string, string | undefined>): string => {
  try {
    validateIngestEnv(env);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
};

/** The variables of an env file (KEY=value lines; commented-out ones too). */
const envFile = (name: string): Record<string, string> => {
  const text = readFileSync(path.resolve(import.meta.dirname, '../../../..', name), 'utf8');
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m && m[2]) vars[m[1]!] = m[2];
  }
  return vars;
};

describe('production env: a complete production environment', () => {
  it('starts the API and the worker', () => {
    const env = validateEnv(api);
    expect(env.NODE_ENV).toBe('production');
    expect(env.INGEST_IN_PROCESS).toBe(false);
    expect(env.QUEUE_WORKERS).toBe(true);
    expect(validateEnv({ ...api, QUEUE_WORKERS: 'false' }).QUEUE_WORKERS).toBe(false);
  });

  it('starts the device receiver', () => {
    expect(receiverError(receiver)).toBe('');
  });
});

describe('production env: the API and the worker', () => {
  it('refuses the development and test SMS providers, the default included', () => {
    for (const SMS_PROVIDER of ['console', 'memory', 'outbox', undefined]) {
      expect(apiError({ ...api, SMS_PROVIDER })).toMatch(/SMS_PROVIDER/);
    }
    expect(apiError({ ...api, SMS_PROVIDER: 'none' })).toBe('');
  });

  it('refuses a trust proxy that believes every client (true, or a /0 range)', () => {
    for (const key of ['TRUST_PROXY', 'INGEST_TRUST_PROXY']) {
      for (const value of ['true', 'TRUE', '0.0.0.0/0', '10.0.0.1, ::/0']) {
        expect(apiError({ ...api, [key]: value })).toMatch(new RegExp(`${key} must be false`));
      }
      for (const value of ['false', '1', '2', '10.0.0.2', '172.18.0.0/16', 'loopback']) {
        expect(apiError({ ...api, [key]: value })).toBe('');
      }
    }
  });

  it('requires REDIS_URL and TRUST_PROXY to be set (their defaults suit a laptop only)', () => {
    for (const key of ['REDIS_URL', 'TRUST_PROXY']) {
      expect(apiError({ ...api, [key]: undefined })).toContain(`${key} must be set in production`);
      expect(apiError({ ...api, [key]: ' ' })).toContain(`${key} must be set in production`);
    }
  });

  it('refuses the device receiver inside the API process', () => {
    expect(apiError({ ...api, INGEST_IN_PROCESS: 'true' })).toMatch(/INGEST_IN_PROCESS/);
    expect(apiError({ ...api, INGEST_IN_PROCESS: 'false' })).toBe('');
  });

  it('allows https origins only, never local ones or a wildcard', () => {
    for (const origin of [
      'http://app.jantrik.com.bd',
      'http://localhost:3000',
      'https://localhost:3000',
      'https://127.0.0.1',
      'https://[::1]:3000',
      'https://0.0.0.0',
      'https://web.localhost',
      '*',
      'app.jantrik.com.bd',
    ]) {
      expect(apiError({ ...api, CORS_ORIGINS: `https://app.jantrik.com.bd,${origin}` })).toMatch(
        /CORS_ORIGINS must hold https origins only/,
      );
    }
    // The default (http://localhost:3000) too, and an empty list.
    expect(apiError({ ...api, CORS_ORIGINS: undefined })).toMatch(/CORS_ORIGINS/);
    expect(apiError({ ...api, CORS_ORIGINS: ' , ' })).toMatch(/CORS_ORIGINS must list/);
    expect(unsafeOrigin('https://app.jantrik.com.bd')).toBeNull();
  });

  it('refuses secrets shorter than 32 characters', () => {
    for (const key of ['JWT_ACCESS_SECRET', 'OTP_PEPPER', 'PLATFORM_TOTP_KEY']) {
      expect(apiError({ ...api, [key]: 'k'.repeat(31) })).toMatch(new RegExp(key));
    }
  });

  it('refuses the example and test secrets (the two env examples, CI, the test configs)', () => {
    const example = envFile('.env.example');
    const prodExample = envFile('deploy/.env.prod.example');
    const copied = [
      example['JWT_ACCESS_SECRET']!,
      example['OTP_PEPPER']!,
      prodExample['JWT_ACCESS_SECRET']!,
      prodExample['OTP_PEPPER']!,
      prodExample['PLATFORM_TOTP_KEY']!,
      'test-only-access-secret-0123456789abcdefghij',
      'ci-only-otp-pepper-0123456789abcdefghijklmno',
      'CHANGE_ME_generate_with_openssl_rand_base64_48',
      'placeholder-placeholder-placeholder-1234',
      'app_dev_password_0123456789abcdefghijklmn',
      'owner_ci_password_0123456789abcdefghijklm',
    ];
    for (const value of copied) expect(value).toMatch(/.{32}/);
    for (const key of ['JWT_ACCESS_SECRET', 'OTP_PEPPER', 'PLATFORM_TOTP_KEY']) {
      for (const value of copied) {
        expect(apiError({ ...api, [key]: value })).toContain(`${key} is an example value`);
      }
    }
  });

  it('refuses one secret used for two purposes', () => {
    expect(apiError({ ...api, OTP_PEPPER: api.JWT_ACCESS_SECRET })).toContain(
      'OTP_PEPPER must differ from JWT_ACCESS_SECRET',
    );
    expect(apiError({ ...api, PLATFORM_TOTP_KEY: api.OTP_PEPPER })).toContain(
      'PLATFORM_TOTP_KEY must differ from OTP_PEPPER',
    );
  });

  it('refuses the schema owner, the superuser and a URL without a login for the runtime logins', () => {
    for (const key of ['DATABASE_URL', 'DATABASE_PLATFORM_URL', 'DATABASE_INGEST_URL']) {
      for (const user of ['jantrik_owner', 'postgres']) {
        expect(apiError({ ...api, [key]: `postgresql://${user}:pw@db:5432/jantrik` })).toContain(
          `${key} must not log in as ${user} in production`,
        );
      }
      for (const url of ['postgresql://db:5432/jantrik', 'mysql://jantrik_app:pw@db/jantrik']) {
        expect(apiError({ ...api, [key]: url })).toContain(`${key} must be a postgresql:// URL`);
      }
    }
    // DATABASE_INGEST_URL is optional for the API (the receiver is its own process).
    expect(
      apiError({
        ...api,
        DATABASE_INGEST_URL: 'postgres://jantrik_ingest_app:pw@db/jantrik',
      }),
    ).toBe('');
  });

  it('refuses an example or short Redis password; a URL without one is allowed', () => {
    for (const password of ['CHANGE_ME_openssl_rand_hex_24', 'short', 'x'.repeat(23)]) {
      expect(apiError({ ...api, REDIS_URL: `redis://:${password}@redis:6379` })).toContain(
        'REDIS_URL holds an example password or one under 24 characters',
      );
    }
    expect(apiError({ ...api, REDIS_URL: `redis://:${'a1'.repeat(24)}@redis:6379` })).toBe('');
    expect(apiError({ ...api, REDIS_URL: 'redis://redis:6379' })).toBe('');
    // ioredis reads ?password= too.
    expect(apiError({ ...api, REDIS_URL: 'redis://redis:6379/0?password=short' })).toContain(
      'REDIS_URL holds an example password',
    );
    expect(apiError({ ...api, REDIS_URL: `redis://redis:6379?password=${'c4'.repeat(24)}` })).toBe(
      '',
    );
  });

  it("refuses the database's admin secrets in its environment (owner URL, superuser and role passwords)", () => {
    for (const key of DATABASE_ADMIN_SECRETS) {
      expect(apiError({ ...api, [key]: 'a1'.repeat(24) })).toContain(
        `${key} must not be given to the API or the worker in production`,
      );
    }
  });

  it('keeps the rules that were there: Secure cookie, no DEV_LAN, no test date, keys and host', () => {
    expect(apiError({ ...api, COOKIE_SECURE: 'false' })).toMatch(/COOKIE_SECURE/);
    expect(apiError({ ...api, DEV_LAN: 'true' })).toMatch(/DEV_LAN/);
    expect(apiError({ ...api, JANTRIK_TEST_TODAY: '2026-10-21' })).toMatch(/JANTRIK_TEST_TODAY/);
    expect(apiError({ ...api, PLATFORM_TOTP_KEY: undefined })).toMatch(/PLATFORM_TOTP_KEY/);
    for (const INGEST_PUBLIC_HOST of [undefined, 'localhost', '0.0.0.0']) {
      expect(apiError({ ...api, INGEST_PUBLIC_HOST })).toMatch(/INGEST_PUBLIC_HOST/);
    }
  });
});

describe('production env: the device receiver', () => {
  it('refuses a trust proxy that believes every client', () => {
    for (const value of ['true', '::/0']) {
      expect(receiverError({ ...receiver, INGEST_TRUST_PROXY: value })).toMatch(
        /INGEST_TRUST_PROXY must be false/,
      );
    }
    for (const value of ['false', '1', '10.0.0.2']) {
      expect(receiverError({ ...receiver, INGEST_TRUST_PROXY: value })).toBe('');
    }
  });

  it('logs in as its own role only', () => {
    for (const user of ['jantrik_owner', 'postgres', 'jantrik_app', 'jantrik_platform_app']) {
      expect(
        receiverError({
          ...receiver,
          DATABASE_INGEST_URL: `postgresql://${user}:pw@db:5432/jantrik`,
        }),
      ).toContain(`DATABASE_INGEST_URL must not log in as ${user} in production`);
    }
  });

  it('requires REDIS_URL', () => {
    expect(receiverError({ ...receiver, REDIS_URL: undefined })).toContain(
      'REDIS_URL must be set in production',
    );
  });

  it("refuses to start when it is given any of the API's logins or secrets", () => {
    for (const key of API_ONLY_SECRETS) {
      expect(receiverError({ ...receiver, [key]: 'anything' })).toContain(
        `${key} must not be given to the device receiver in production`,
      );
    }
    // An empty value is not a secret given.
    expect(receiverError({ ...receiver, DATABASE_URL: '' })).toBe('');
  });

  it("refuses the database's admin secrets too", () => {
    for (const key of DATABASE_ADMIN_SECRETS) {
      expect(receiverError({ ...receiver, [key]: 'a1'.repeat(24) })).toContain(
        `${key} must not be given to the device receiver in production`,
      );
    }
  });

  it('refuses an example or short Redis password', () => {
    expect(
      receiverError({
        ...receiver,
        REDIS_URL: 'redis://:CHANGE_ME_openssl_rand_hex_24@redis:6379',
      }),
    ).toContain('REDIS_URL holds an example password');
    expect(receiverError({ ...receiver, REDIS_URL: `redis://:${'b2'.repeat(24)}@redis` })).toBe('');
  });
});

describe('production env: development and tests are not affected', () => {
  it('accepts the API as Playwright starts it (NODE_ENV=test, outbox SMS, http://localhost)', () => {
    // apps/web/playwright.config.ts → webServer (the API).
    const e2e = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://jantrik_app:app_ci_password@localhost:5432/jantrik_e2e',
      DATABASE_PLATFORM_URL: 'postgresql://jantrik_platform_app:p@localhost:5432/jantrik_e2e',
      DATABASE_INGEST_URL: 'postgresql://jantrik_ingest_app:i@localhost:5432/jantrik_e2e',
      INGEST_IN_PROCESS: 'true',
      INGEST_TRUST_PROXY: 'true',
      REDIS_URL: 'redis://localhost:6379/2',
      SMS_PROVIDER: 'outbox',
      JANTRIK_TEST_TODAY: '2026-10-21',
      CORS_ORIGINS: 'http://localhost:3000',
      JWT_ACCESS_SECRET: 'ci-only-access-secret-0123456789abcdefghijkl',
      OTP_PEPPER: 'ci-only-otp-pepper-0123456789abcdefghijklmno',
    };
    expect(apiError(e2e)).toBe('');
    // The API tests (apps/api/vitest.config.ts): TRUST_PROXY=true, memory SMS.
    expect(apiError({ ...e2e, TRUST_PROXY: 'true', SMS_PROVIDER: 'memory' })).toBe('');
  });

  it('accepts the development defaults', () => {
    const dev = {
      DATABASE_URL: 'postgresql://jantrik_app:app_dev_password@localhost:5432/jantrik',
      DATABASE_PLATFORM_URL: 'postgresql://jantrik_platform_app:p@localhost:5432/jantrik',
      DATABASE_INGEST_URL: 'postgresql://jantrik_ingest_app:i@localhost:5432/jantrik',
      ...Object.fromEntries(
        Object.entries(envFile('.env.example')).filter(([k]) =>
          ['JWT_ACCESS_SECRET', 'OTP_PEPPER', 'CORS_ORIGINS', 'SMS_PROVIDER'].includes(k),
        ),
      ),
    };
    expect(apiError(dev)).toBe('');
    expect(envSchema.parse(dev).NODE_ENV).toBe('development');
  });

  it('accepts the receiver inside the development API, given every API variable', () => {
    expect(
      receiverError({
        ...receiver,
        NODE_ENV: 'development',
        REDIS_URL: undefined,
        INGEST_TRUST_PROXY: 'true',
        DATABASE_URL: 'postgresql://jantrik_app:x@localhost/jantrik',
        JWT_ACCESS_SECRET: 'x'.repeat(40),
      }),
    ).toBe('');
  });

  it('trustsAnyClient reads lists and cases', () => {
    expect(trustsAnyClient('loopback, 10.0.0.0/8')).toBe(false);
    expect(trustsAnyClient('loopback, True')).toBe(true);
  });
});

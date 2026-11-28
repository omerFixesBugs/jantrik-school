import path from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

// e2e tests run against the real jantrik_test database and Redis DB 1 (docker compose up -d).
config({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
};

/**
 * The platform login (user and password of DATABASE_PLATFORM_URL) on the test database: server,
 * port and database always come from DATABASE_URL_TEST, so the tests never reach another one.
 */
const platformUrl = (): string => {
  const url = new URL(required('DATABASE_URL_TEST'));
  const login = new URL(required('DATABASE_PLATFORM_URL'));
  url.username = login.username;
  url.password = login.password;
  return url.toString();
};

/** The password login's login (DATABASE_LOGIN_URL) on the test database, derived like the platform one. */
const loginUrl = (): string => {
  const url = new URL(required('DATABASE_URL_TEST'));
  const login = new URL(required('DATABASE_LOGIN_URL'));
  url.username = login.username;
  url.password = login.password;
  return url.toString();
};

/** The device receiver's login (DATABASE_INGEST_URL) on the test database, derived like the platform one. */
const ingestUrl = (): string => {
  const url = new URL(required('DATABASE_URL_TEST'));
  const login = new URL(required('DATABASE_INGEST_URL'));
  url.username = login.username;
  url.password = login.password;
  return url.toString();
};

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    // One app (and one BullMQ worker) at a time, so queued SMS reach the right test.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: required('DATABASE_URL_TEST'),
      DATABASE_PLATFORM_URL: platformUrl(),
      DATABASE_LOGIN_URL: loginUrl(),
      DATABASE_INGEST_URL: ingestUrl(),
      DATABASE_MIGRATION_URL_TEST: required('DATABASE_MIGRATION_URL_TEST'),
      REDIS_URL: process.env['REDIS_URL_TEST'] ?? 'redis://localhost:6379/1',
      QUEUE_PREFIX: 'jantrik-test',
      JWT_ACCESS_SECRET: 'test-only-access-secret-0123456789abcdefghij',
      OTP_PEPPER: 'test-only-otp-pepper-0123456789abcdefghijklm',
      SMS_PROVIDER: 'memory',
      // Online payments: SSLCommerz is an address nothing listens on, so no test can reach the
      // real one (sandbox included); a test that needs it starts the fake SSLCommerz and passes
      // its address to createHarness (test/support/fake-sslcommerz.ts).
      SSLCOMMERZ_BASE_URL: 'http://127.0.0.1:9',
      // The public admission form's Turnstile check, without Cloudflare (docs/admission.md).
      TURNSTILE_PROVIDER: 'fake',
      COOKIE_SECURE: 'true',
      // A developer's .env may enable phone testing; tests never run with it.
      DEV_LAN: 'false',
      // Tests send X-Forwarded-For to simulate different client IPs.
      TRUST_PROXY: 'true',
      // The test harness boots the device receiver itself.
      INGEST_IN_PROCESS: 'false',
      INGEST_TRUST_PROXY: 'true',
      // http://app.test stands for the institute app on its own origin: CORS allows it, the
      // platform routes must not (platform-auth.e2e-spec.ts → the Origin check). The env is
      // validated once, when AppModule is imported, so this cannot be set per test file.
      CORS_ORIGINS: 'http://localhost:3000,http://app.test',
      PLATFORM_ORIGINS: 'http://localhost:3000',
    },
  },
});

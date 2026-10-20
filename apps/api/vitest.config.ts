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
      DATABASE_MIGRATION_URL_TEST: required('DATABASE_MIGRATION_URL_TEST'),
      REDIS_URL: process.env['REDIS_URL_TEST'] ?? 'redis://localhost:6379/1',
      QUEUE_PREFIX: 'jantrik-test',
      JWT_ACCESS_SECRET: 'test-only-access-secret-0123456789abcdefghij',
      OTP_PEPPER: 'test-only-otp-pepper-0123456789abcdefghijklm',
      SMS_PROVIDER: 'memory',
      COOKIE_SECURE: 'true',
      // A developer's .env may enable phone testing; tests never run with it.
      DEV_LAN: 'false',
      // Tests send X-Forwarded-For to simulate different client IPs.
      TRUST_PROXY: 'true',
      CORS_ORIGINS: 'http://localhost:3000',
    },
  },
});

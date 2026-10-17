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
      DATABASE_MIGRATION_URL_TEST: required('DATABASE_MIGRATION_URL_TEST'),
      REDIS_URL: process.env['REDIS_URL_TEST'] ?? 'redis://localhost:6379/1',
      QUEUE_PREFIX: 'jantrik-test',
      JWT_ACCESS_SECRET: 'test-only-access-secret-0123456789abcdefghij',
      OTP_PEPPER: 'test-only-otp-pepper-0123456789abcdefghijklm',
      SMS_PROVIDER: 'memory',
      COOKIE_SECURE: 'true',
      // Tests send X-Forwarded-For to simulate different client IPs.
      TRUST_PROXY: 'true',
      CORS_ORIGINS: 'http://localhost:3000',
    },
  },
});

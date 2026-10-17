import path from 'node:path';
import nextEnv from '@next/env';
import { defineConfig, devices } from '@playwright/test';

// End-to-end: the built API and web app against the seeded jantrik_e2e database.
// Build first (`pnpm build`); stop any dev servers on ports 3000/4000.
nextEnv.loadEnvConfig(path.resolve(import.meta.dirname, '../..'));

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
};

export const E2E_REDIS_URL = process.env['REDIS_URL_E2E'] ?? 'redis://localhost:6379/2';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // Tests share seeded demo users; run them one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    locale: 'bn-BD',
    timezoneId: 'Asia/Dhaka',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: path.resolve(import.meta.dirname, '../api'),
      url: 'http://localhost:4000/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...(process.env as Record<string, string>),
        NODE_ENV: 'test',
        API_PORT: '4000',
        DATABASE_URL: required('DATABASE_URL_E2E'),
        REDIS_URL: E2E_REDIS_URL,
        QUEUE_PREFIX: 'jantrik-e2e',
        SMS_PROVIDER: 'outbox',
        CORS_ORIGINS: 'http://localhost:3000',
      },
    },
    {
      command: 'pnpm start',
      cwd: import.meta.dirname,
      url: 'http://localhost:3000/login',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});

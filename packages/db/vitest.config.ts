import { defineConfig } from 'vitest/config';

// Integration tests against a real Postgres (docker compose up -d) using the jantrik_test DB.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Locally at most two workers, so the full gates fit in a developer PC's memory; CI keeps
    // Vitest's default (one per core).
    maxWorkers: process.env['CI'] ? undefined : 2,
  },
});

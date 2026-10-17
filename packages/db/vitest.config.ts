import { defineConfig } from 'vitest/config';

// Integration tests against a real Postgres (docker compose up -d) using the jantrik_test DB.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

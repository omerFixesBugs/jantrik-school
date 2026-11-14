import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Unit tests for the web's plain TypeScript (lib/): no browser, no Next.js. Playwright covers pages.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    // perf/: the size budget script (check-budget.mjs) is plain Node.
    include: ['src/**/*.test.ts', 'perf/**/*.test.mjs'],
    maxWorkers: process.env['CI'] ? undefined : 2,
  },
});

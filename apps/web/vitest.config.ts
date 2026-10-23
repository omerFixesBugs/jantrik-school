import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Unit tests for the web's plain TypeScript (lib/): no browser, no Next.js. Playwright covers pages.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    include: ['src/**/*.test.ts'],
    maxWorkers: process.env['CI'] ? undefined : 2,
  },
});

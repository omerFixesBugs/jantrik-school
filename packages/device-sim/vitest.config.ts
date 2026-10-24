import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Locally at most two workers, so the full gates fit in a developer PC's memory; CI keeps
    // Vitest's default (one per core).
    maxWorkers: process.env['CI'] ? undefined : 2,
  },
});

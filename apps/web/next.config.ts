import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// Single root .env for the monorepo (cwd is apps/web when run via pnpm/turbo).
// Not @next/env's loadEnvConfig: Next has already called it for apps/web by now, and a second
// call returns that cached (empty) result without reading this file; its forceReload option
// would reset process.env to an older snapshot. Node's loader never overrides variables that
// are already set (shell, CI), and CI has no .env file at all.
try {
  process.loadEnvFile(path.resolve(process.cwd(), '../../.env'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// Dev only (DEV_LAN=true in .env): let a phone on the same Wi-Fi load the dev server at the
// PC's private IP. allowedDevOrigins has no effect outside `next dev`. One `*` = one label.
const LAN_DEV_ORIGINS = ['192.168.*.*', '10.*.*.*', '172.*.*.*'];

const nextConfig: NextConfig = {
  ...(process.env['DEV_LAN'] === 'true' ? { allowedDevOrigins: LAN_DEV_ORIGINS } : {}),
  // cacheComponents is off: the root layout reads the locale cookie, and every page is per-user
  // with data fetched in the browser, so prerendered/cached components would not help.
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default withNextIntl(nextConfig);

import type { Env } from './env.js';

/**
 * Dev-only LAN access (`DEV_LAN=true`), so the app can be tried on a phone on the same Wi-Fi.
 * Env validation refuses DEV_LAN outside NODE_ENV=development, so none of this can loosen a
 * test or production server.
 */

/** The web dev server's port: the only port a LAN origin may use. */
export const DEV_WEB_PORT = '3000';

const PRIVATE_IPV4 = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
];

/** `http://<private IPv4>:3000`, e.g. http://192.168.0.200:3000. */
export function isPrivateLanOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    url.port === DEV_WEB_PORT &&
    url.pathname === '/' &&
    PRIVATE_IPV4.some((re) => re.test(url.hostname))
  );
}

type CorsEnv = Pick<Env, 'NODE_ENV' | 'DEV_LAN' | 'CORS_ORIGINS'>;

/** Whether a browser origin may call the API with credentials. */
export function isAllowedOrigin(origin: string, env: CorsEnv): boolean {
  if (env.CORS_ORIGINS.includes(origin)) return true;
  return env.NODE_ENV === 'development' && env.DEV_LAN && isPrivateLanOrigin(origin);
}

/**
 * The refresh cookie's Secure flag. Browsers refuse Secure cookies over plain http except on
 * localhost, so a phone on the LAN needs it off: in development with DEV_LAN only.
 */
export function refreshCookieSecure(
  env: Pick<Env, 'NODE_ENV' | 'DEV_LAN' | 'COOKIE_SECURE'>,
): boolean {
  if (env.NODE_ENV === 'development' && env.DEV_LAN) return false;
  return env.COOKIE_SECURE;
}

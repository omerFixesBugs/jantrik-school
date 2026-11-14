import { isPrivateLanOrigin } from '../config/dev-lan.js';

/** The settings the platform's origin check reads (env.ts). */
export interface PlatformOriginEnv {
  NODE_ENV: string;
  DEV_LAN: boolean;
  /** Normalised origins (`new URL(entry).origin`), e.g. `https://platform.jantrik.com.bd`. */
  PLATFORM_ORIGINS: readonly string[];
}

/**
 * Whether a request's `Origin` may call /platform/* (PlatformAuthGuard). Only the platform's own
 * web origins: the institute app is in CORS_ORIGINS too and shares the platform cookie's site, so
 * CORS alone would let an XSS there use a platform session (deployment requirement 1). A missing
 * Origin is refused: browsers send one on every cross-origin call, and the platform web app calls
 * the API from another origin (api.<domain>). In development with DEV_LAN, a private-LAN origin
 * is accepted as CORS accepts it.
 *
 * If the API is ever served from the platform's own origin (step 12, part C), same-origin GETs
 * carry no Origin and this check must also accept `Sec-Fetch-Site: same-origin`.
 */
export function isPlatformOrigin(origin: string | undefined, env: PlatformOriginEnv): boolean {
  if (!origin) return false;
  if (env.PLATFORM_ORIGINS.includes(origin)) return true;
  return env.NODE_ENV === 'development' && env.DEV_LAN && isPrivateLanOrigin(origin);
}

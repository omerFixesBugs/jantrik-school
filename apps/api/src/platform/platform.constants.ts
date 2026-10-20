/** The platform session cookie (httpOnly, Secure, SameSite=Strict), sent only to /platform. */
export const PLATFORM_COOKIE = 'jantrik_ps';
export const PLATFORM_COOKIE_PATH = '/platform';
/** Short sessions (approved): 30 minutes idle, 8 hours at most. */
export const PLATFORM_IDLE_SEC = 30 * 60;
export const PLATFORM_MAX_SEC = 8 * 3600;
/** Between the password and the code. */
export const CHALLENGE_TTL_SEC = 5 * 60;
export const CHALLENGE_MAX_ATTEMPTS = 5;
/** Second-factor attempts per admin (across challenges) and per 15 minutes. */
export const VERIFY_PER_ADMIN_PER_15MIN = 10;
/** And per day (long, slow guessing with a known password). */
export const VERIFY_PER_ADMIN_PER_DAY = 30;
/** Requests with a session cookie per IP and minute, before the session lookup. */
export const PLATFORM_REQUESTS_PER_IP_PER_MIN = 300;

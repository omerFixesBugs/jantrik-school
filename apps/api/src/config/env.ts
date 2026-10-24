import { isoDateSchema } from '@jantrik/shared';
import { z } from 'zod';

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/** The receiver runs inside the API unless told otherwise; production runs it as its own process. */
const ingestInProcess = (env: { INGEST_IN_PROCESS?: boolean | undefined; NODE_ENV: string }) =>
  env.INGEST_IN_PROCESS ?? env.NODE_ENV !== 'production';

/** Environment variables the API needs. Validated once at startup. */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    /** Comma-separated allowlist of browser origins (credentials are allowed). */
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((v) =>
        v
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      ),
    /** Express "trust proxy": false, true, a hop count, or a list of subnets. */
    TRUST_PROXY: z.string().default('false'),
    DATABASE_URL: z.string().min(1),
    /**
     * The platform module's own login (role jantrik_platform_app): the only role that may run the
     * platform_* functions. Same database as DATABASE_URL.
     */
    DATABASE_PLATFORM_URL: z.string().min(1),
    /**
     * The device receiver's own login (role jantrik_ingest_app): the only role that may run the
     * ingest_* functions. Same database as DATABASE_URL. Required when the receiver runs in this
     * process.
     */
    DATABASE_INGEST_URL: z.string().min(1).optional(),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    /** BullMQ key prefix, so several environments can share one Redis. */
    QUEUE_PREFIX: z.string().min(1).default('jantrik'),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    /** HMAC key for OTP codes stored in Redis. */
    OTP_PEPPER: z.string().min(32, 'OTP_PEPPER must be at least 32 characters'),
    /**
     * Encrypts platform admins' TOTP secrets and keys their backup-code hashes. Required in
     * production; elsewhere one is derived from OTP_PEPPER when unset. Changing it invalidates
     * every enrolment (re-enrol through `pnpm platform:admin reset-2fa`).
     */
    PLATFORM_TOTP_KEY: z
      .string()
      .min(32, 'PLATFORM_TOTP_KEY must be at least 32 characters')
      .optional(),
    /** Set the refresh cookie's Secure flag. Browsers accept Secure cookies on http://localhost. */
    COOKIE_SECURE: z.stringbool().default(true),
    /**
     * Development only: allow the web app on a private LAN address (a phone on the same Wi-Fi):
     * CORS for http://<private IP>:3000 and the refresh cookie without Secure (plain http).
     * Refused in any other NODE_ENV. See src/config/dev-lan.ts.
     */
    DEV_LAN: z.stringbool().default(false),
    /**
     * `console` logs codes (development only); `memory` keeps them in-process (API tests);
     * `outbox` pushes them to a Redis list that Playwright reads (e2e). Never in production.
     */
    SMS_PROVIDER: z.enum(['console', 'memory', 'outbox']).default('console'),
    /**
     * Tests only: a fixed "today" (YYYY-MM-DD) for every calendar date the API works out (the
     * end-to-end suite sets it; `todayIn` in @jantrik/shared reads it). Timestamps stay real.
     * Refused in any other NODE_ENV.
     */
    JANTRIK_TEST_TODAY: isoDateSchema.optional(),

    // Device receiver (ZKTeco attendance machines).
    /** Run the receiver inside the API process. Default: yes, except in production (own process). */
    INGEST_IN_PROCESS: z.stringbool().optional(),
    INGEST_PORT: positiveInt(4080),
    /** Host and port a device is told to connect to; shown to admins in the device setup guide. */
    INGEST_PUBLIC_HOST: z.string().min(1).default('localhost'),
    INGEST_PUBLIC_PORT: z.coerce.number().int().positive().optional(),
    /** Express "trust proxy" for the receiver (same values as TRUST_PROXY). */
    INGEST_TRUST_PROXY: z.string().default('false'),
    INGEST_PER_IP_PER_MIN: positiveInt(1200),
    /** Requests per minute for one serial number from one address (an IPv6 /64). */
    INGEST_PER_DEVICE_PER_MIN: positiveInt(300),
    /**
     * Requests per minute for one serial number from all the addresses it does not trust, together
     * (a trusted address has only its own share above).
     */
    INGEST_PER_DEVICE_ALL_PER_MIN: positiveInt(1200),
    INGEST_REFUSED_PER_IP_PER_10MIN: positiveInt(30),
    INGEST_MAX_ATTLOG_BYTES: positiveInt(524288),
    INGEST_MAX_DRAIN_BYTES: positiveInt(2097152),

    // Rate limits. Per-phone / per-identifier limits are the real protection; per-IP limits are
    // generous because many Bangladeshi users share one IP (carrier CGNAT, school Wi-Fi).
    RATE_LIMIT_USER_PER_MIN: positiveInt(300),
    RATE_LIMIT_IP_PER_MIN: positiveInt(600),
    OTP_REQUEST_PER_IP_PER_HOUR: positiveInt(200),
    OTP_PER_PHONE_COOLDOWN_SEC: positiveInt(60),
    OTP_PER_PHONE_PER_15MIN: positiveInt(5),
    OTP_PER_PHONE_PER_DAY: positiveInt(10),
    LOGIN_PER_IP_PER_15MIN: positiveInt(300),
    LOGIN_PER_IDENTIFIER_PER_15MIN: positiveInt(5),
    // Staff invitations (POST /staff and re-invites) per institute and hour.
    STAFF_INVITES_PER_TENANT_PER_HOUR: positiveInt(30),
  })
  .superRefine((env, ctx) => {
    // Loosened settings must never leave a developer's machine.
    if (env.DEV_LAN && env.NODE_ENV !== 'development') {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_LAN'],
        message: 'DEV_LAN is for NODE_ENV=development only',
      });
    }
    if (env.JANTRIK_TEST_TODAY && env.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: 'custom',
        path: ['JANTRIK_TEST_TODAY'],
        message: 'JANTRIK_TEST_TODAY is for NODE_ENV=test only',
      });
    }
    if (!env.PLATFORM_TOTP_KEY && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['PLATFORM_TOTP_KEY'],
        message: 'PLATFORM_TOTP_KEY is required in production',
      });
    }
    if (ingestInProcess(env) && !env.DATABASE_INGEST_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_INGEST_URL'],
        message:
          'DATABASE_INGEST_URL is required when the device receiver runs in the API process (INGEST_IN_PROCESS)',
      });
    }
    if (!env.COOKIE_SECURE && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'COOKIE_SECURE must be true in production',
      });
    }
  })
  .transform((env) => ({
    ...env,
    INGEST_IN_PROCESS: ingestInProcess(env),
    INGEST_PUBLIC_PORT: env.INGEST_PUBLIC_PORT ?? env.INGEST_PORT,
  }));

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Express `trust proxy` value from the TRUST_PROXY string. */
export function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

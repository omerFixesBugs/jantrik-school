import { z } from 'zod';

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

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
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    /** BullMQ key prefix, so several environments can share one Redis. */
    QUEUE_PREFIX: z.string().min(1).default('jantrik'),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    /** HMAC key for OTP codes stored in Redis. */
    OTP_PEPPER: z.string().min(32, 'OTP_PEPPER must be at least 32 characters'),
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
    if (!env.COOKIE_SECURE && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'COOKIE_SECURE must be true in production',
      });
    }
  });

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

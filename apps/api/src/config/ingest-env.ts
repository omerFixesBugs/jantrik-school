import { z } from 'zod';

export const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

/**
 * The device receiver's port, proxy rule and limits. The stand-alone receiver reads them, and so
 * does the API schema (the receiver runs inside the API in development).
 */
export const ingestReceiverFields = {
  INGEST_PORT: positiveInt(4080),
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
};

/**
 * Environment variables of the device receiver (IngestAppModule: `ingest-main.ts` in production,
 * or started by `api.bootstrap.ts` in development). Only what it uses: it is open to the internet
 * without a login, so it never needs the API's logins or secrets (DATABASE_URL, the JWT secret,
 * the OTP pepper, the platform's). Validated as soon as IngestAppModule is imported.
 */
export const ingestEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Its own database login (role jantrik_ingest_app): the four ingest_* functions only. */
  DATABASE_INGEST_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  /** BullMQ key prefix: the API's, so the API's devices worker gets the receiver's jobs. */
  QUEUE_PREFIX: z.string().min(1).default('jantrik'),
  ...ingestReceiverFields,
});

export type IngestEnv = z.infer<typeof ingestEnvSchema>;

export function validateIngestEnv(config: Record<string, unknown>): IngestEnv {
  const result = ingestEnvSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Invalid environment variables for the device receiver:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

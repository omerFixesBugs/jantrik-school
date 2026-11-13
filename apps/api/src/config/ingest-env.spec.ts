import { envSchema } from './env.js';
import { ingestEnvSchema, validateIngestEnv } from './ingest-env.js';

/** Everything a production receiver is given: its own login, Redis and the queue prefix. */
const receiver = {
  NODE_ENV: 'production',
  DATABASE_INGEST_URL: 'postgresql://jantrik_ingest_app:x@db/jantrik',
  REDIS_URL: 'redis://redis:6379',
  QUEUE_PREFIX: 'jantrik',
};

describe('env: the stand-alone device receiver', () => {
  it('starts with its own variables only: none of the API logins or secrets', () => {
    const env = validateIngestEnv(receiver);
    expect(env).toEqual({
      ...receiver,
      INGEST_PORT: 4080,
      INGEST_TRUST_PROXY: 'false',
      INGEST_PER_IP_PER_MIN: 1200,
      INGEST_PER_DEVICE_PER_MIN: 300,
      INGEST_PER_DEVICE_ALL_PER_MIN: 1200,
      INGEST_REFUSED_PER_IP_PER_10MIN: 30,
      INGEST_MAX_ATTLOG_BYTES: 524288,
      INGEST_MAX_DRAIN_BYTES: 2097152,
    });
    // The API schema refuses that same environment (it needs its logins and secrets).
    expect(envSchema.safeParse(receiver).success).toBe(false);
  });

  it('refuses to start without DATABASE_INGEST_URL', () => {
    const { DATABASE_INGEST_URL: _omit, ...without } = receiver;
    expect(() => validateIngestEnv(without)).toThrow(/DATABASE_INGEST_URL/);
    expect(() => validateIngestEnv({ ...receiver, DATABASE_INGEST_URL: '' })).toThrow(
      /DATABASE_INGEST_URL/,
    );
  });

  it('reads its limits and proxy rule as the API does, and keeps nothing else it is given', () => {
    const env = ingestEnvSchema.parse({
      ...receiver,
      INGEST_PORT: '4280',
      INGEST_TRUST_PROXY: '1',
      INGEST_PER_IP_PER_MIN: '600',
      JWT_ACCESS_SECRET: 'x'.repeat(40),
      DATABASE_URL: 'postgresql://jantrik_app:x@db/jantrik',
    });
    expect(env).toMatchObject({
      INGEST_PORT: 4280,
      INGEST_TRUST_PROXY: '1',
      INGEST_PER_IP_PER_MIN: 600,
    });
    expect(Object.keys(env)).not.toContain('JWT_ACCESS_SECRET');
    expect(Object.keys(env)).not.toContain('DATABASE_URL');
    expect(() => validateIngestEnv({ ...receiver, INGEST_PER_IP_PER_MIN: '0' })).toThrow(
      /INGEST_PER_IP_PER_MIN/,
    );
  });
});

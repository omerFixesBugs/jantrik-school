import { loadSandboxStart } from '../scripts/payments-load-sandbox.js';
import { smokeStart } from '../scripts/payments-sandbox-smoke.js';

// The owner's two commands (sprint 1 P7a, docs/payments.md → Commands). Only their refusals are
// tested: the smoke run calls the real SSLCommerz sandbox and is the owner's to run, never CI's.

const STORE = {
  SSLCOMMERZ_SANDBOX_STORE_ID: 'mystore01',
  SSLCOMMERZ_SANDBOX_STORE_PASSWORD: 'Sb-Pw-55@ssl',
};
const LOCAL_DB = 'postgresql://jantrik_app:pw@localhost:5432/jantrik';

/** Every message a start may print: never a credential. */
const noSecret = (message: string) => {
  expect(message).not.toContain(STORE.SSLCOMMERZ_SANDBOX_STORE_PASSWORD);
  expect(message).not.toContain(STORE.SSLCOMMERZ_SANDBOX_STORE_ID);
};

describe('payments:sandbox-smoke', () => {
  it('skips cleanly without both sandbox variables', () => {
    for (const env of [
      {},
      { SSLCOMMERZ_SANDBOX_STORE_ID: 'mystore01' },
      { SSLCOMMERZ_SANDBOX_STORE_PASSWORD: 'Sb-Pw-55@ssl' },
      { SSLCOMMERZ_SANDBOX_STORE_ID: ' ', SSLCOMMERZ_SANDBOX_STORE_PASSWORD: 'x' },
    ]) {
      const start = smokeStart(env);
      expect(start.kind, JSON.stringify(env)).toBe('skip');
      if (start.kind !== 'run') noSecret(start.message);
    }
  });

  it('refuses NODE_ENV=production', () => {
    const start = smokeStart({ ...STORE, NODE_ENV: 'production' });
    expect(start.kind).toBe('refuse');
    if (start.kind !== 'run') noSecret(start.message);
  });

  it('runs with both, always against the sandbox (never an override)', () => {
    const start = smokeStart({ ...STORE, SSLCOMMERZ_BASE_URL: 'http://127.0.0.1:4090' });
    expect(start).toMatchObject({
      kind: 'run',
      baseUrl: 'https://sandbox.sslcommerz.com',
      creds: { storeId: 'mystore01', storePassword: 'Sb-Pw-55@ssl' },
    });
  });

  it('refuses credentials that are not a store ID and password', () => {
    const start = smokeStart({ ...STORE, SSLCOMMERZ_SANDBOX_STORE_ID: 'has space' });
    expect(start.kind).toBe('refuse');
    if (start.kind !== 'run') {
      expect(start.message).not.toContain('has space');
      noSecret(start.message);
    }
  });
});

describe('payments:load-sandbox', () => {
  const argv = ['--tenant', 'shapla-school'];
  const env = { ...STORE, DATABASE_URL: LOCAL_DB };

  it('loads onto the named institute of the local dev database', () => {
    expect(loadSandboxStart(env, argv)).toMatchObject({
      kind: 'run',
      slug: 'shapla-school',
      creds: { storeId: 'mystore01' },
    });
    // pnpm passes a lone "--" through.
    expect(loadSandboxStart(env, ['--', '--tenant', 'shapla-school'])).toMatchObject({
      kind: 'run',
    });
    expect(loadSandboxStart(env, ['--tenant=shapla-school'])).toMatchObject({ kind: 'run' });
  });

  it('refuses production, a missing institute, missing variables', () => {
    for (const [e, a] of [
      [{ ...env, NODE_ENV: 'production' }, argv],
      [env, []],
      [env, ['--tenant']],
      [env, ['--tenant', 'Not A Slug!']],
      [{ DATABASE_URL: LOCAL_DB }, argv],
      [{ ...env, SSLCOMMERZ_SANDBOX_STORE_PASSWORD: undefined }, argv],
      [{ ...env, DATABASE_URL: undefined }, argv],
    ] as const) {
      const start = loadSandboxStart(e, [...a]);
      expect(start.kind, JSON.stringify([e, a])).toBe('refuse');
      if (start.kind !== 'run') noSecret(start.message);
    }
  });

  it('refuses a database that is not this machine’s, or not the dev database', () => {
    for (const DATABASE_URL of [
      'postgresql://jantrik_app:pw@db.example.com:5432/jantrik',
      'postgresql://jantrik_app:pw@10.0.0.5:5432/jantrik',
      'postgresql://jantrik_app:pw@localhost:5432/jantrik_test',
      'postgresql://jantrik_app:pw@localhost:5432/jantrik_e2e',
      'not a url',
    ]) {
      const start = loadSandboxStart({ ...env, DATABASE_URL }, argv);
      expect(start.kind, DATABASE_URL).toBe('refuse');
      if (start.kind !== 'run') {
        noSecret(start.message);
        expect(start.message).not.toContain(':pw@');
      }
    }
  });
});

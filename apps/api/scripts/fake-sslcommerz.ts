import { startFakeSslcommerz } from '../test/support/fake-sslcommerz.js';

/*
 * `pnpm --filter @jantrik/api payments:fake`: the fake SSLCommerz on its own (sprint 1 P7a),
 * for Playwright (apps/web/playwright.config.ts starts it as a web server) and for trying the
 * pages locally with SSLCOMMERZ_BASE_URL=http://127.0.0.1:4090. It accepts one store,
 * FAKE_SSLCOMMERZ_STORE_ID with FAKE_SSLCOMMERZ_STORE_PASSWORD (defaults below), on 127.0.0.1
 * only. It never calls SSLCommerz.
 */

const port = Number(process.env['FAKE_SSLCOMMERZ_PORT'] ?? 4090);
const storeId = process.env['FAKE_SSLCOMMERZ_STORE_ID'] ?? 'jantrikfake01';
const storePassword = process.env['FAKE_SSLCOMMERZ_STORE_PASSWORD'] ?? 'jantrikfake01@ssl';

const fake = await startFakeSslcommerz({ port, host: '127.0.0.1' });
fake.addStore(storeId, storePassword);
console.log(`Fake SSLCommerz on ${fake.url} (store ${storeId})`);

const stop = () => {
  void fake.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

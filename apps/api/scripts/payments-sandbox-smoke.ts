import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  methodFromInstrument,
  newTranId,
  sslcommerzCredentialsSchema,
  type SslcommerzCredentials,
} from '@jantrik/shared';
import { config } from 'dotenv';
import { SSLCOMMERZ_SANDBOX_URL, SSLCOMMERZ_TIMEOUT_MS } from '../src/payments/payments.config.js';
import type { PaymentProvider, ProviderAttempt } from '../src/payments/provider.js';
import { SslcommerzProvider } from '../src/payments/sslcommerz/sslcommerz.provider.js';

/*
 * `pnpm --filter @jantrik/api payments:sandbox-smoke` (sprint 1 P7a, docs/payments.md →
 * Commands): the owner's own run against SSLCommerz's sandbox, never CI's. It makes a ৳10 session
 * with a fresh transaction ID and prints the payer page; the owner pays with a documented test
 * card or OTP; it then asks the transaction query API every 5 s for 5 minutes, validates the
 * payment, and prints what SSLCommerz answered (parsed: no credential, no raw body) and which
 * points the documentation leaves open it could see. It writes nothing anywhere.
 *
 * It skips (exit 0) unless SSLCOMMERZ_SANDBOX_STORE_ID and SSLCOMMERZ_SANDBOX_STORE_PASSWORD are
 * both set in the root .env, and refuses NODE_ENV=production.
 */

export type SmokeStart =
  | { kind: 'skip'; message: string }
  | { kind: 'refuse'; message: string }
  | { kind: 'run'; baseUrl: string; creds: SslcommerzCredentials };

/** Whether to run, from the environment. Messages never repeat a value. */
export function smokeStart(env: Record<string, string | undefined>): SmokeStart {
  if (env['NODE_ENV'] === 'production') {
    return { kind: 'refuse', message: 'Refusing: the sandbox smoke run is never for production.' };
  }
  const storeId = env['SSLCOMMERZ_SANDBOX_STORE_ID']?.trim() ?? '';
  const storePassword = env['SSLCOMMERZ_SANDBOX_STORE_PASSWORD'] ?? '';
  if (!storeId || !storePassword) {
    return {
      kind: 'skip',
      message:
        'Skipped: set SSLCOMMERZ_SANDBOX_STORE_ID and SSLCOMMERZ_SANDBOX_STORE_PASSWORD in the root .env (your sandbox store, https://sandbox-gw.sslcommerz.com/register) to run it.',
    };
  }
  const creds = sslcommerzCredentialsSchema.safeParse({ storeId, storePassword });
  if (!creds.success) {
    return {
      kind: 'refuse',
      message:
        'Refusing: the sandbox store ID must be letters, digits, _ or -, and the password 1 to 100 characters without spaces.',
    };
  }
  // Always SSLCommerz's sandbox: a fake's address (SSLCOMMERZ_BASE_URL) is not what this checks.
  return { kind: 'run', baseUrl: SSLCOMMERZ_SANDBOX_URL, creds: creds.data };
}

interface SmokeDeps {
  provider: PaymentProvider;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** The return and IPN base (API_PUBLIC_URL, or a local address SSLCommerz cannot reach). */
  returnBase: string;
}

const describeAttempt = (a: ProviderAttempt) =>
  `${a.status} (amount ${a.amountPaisa ?? 'not a well-formed amount'} paisa, currency ${a.currency ?? '-'}, card_type ${a.instrument ?? '-'})`;

/** The run itself (network only through `deps.provider`). */
export async function runSmoke(creds: SslcommerzCredentials, deps: SmokeDeps): Promise<number> {
  const { provider, log } = deps;
  const seen: string[] = [];
  log('1. The connection test (a query for a transaction that never existed):');
  const test = await provider.testConnection(creds);
  log(`   ${test}`);
  if (test === 'OK')
    seen.push('A query for an unknown tran_id answers APIConnect DONE with nothing found.');
  const wrong = await provider.testConnection({
    ...creds,
    storePassword: `${creds.storePassword}-wrong`,
  });
  log(`   With a wrong password: ${wrong}`);
  if (wrong === 'BAD_CREDENTIALS') seen.push('Bad credentials answer APIConnect FAILED.');
  if (test !== 'OK') {
    log('Stopping: the store did not accept its credentials.');
    return 1;
  }

  const tranId = newTranId();
  const base = deps.returnBase.replace(/\/$/, '');
  log('2. A ৳10 session:');
  const session = await provider.createCheckout(creds, {
    tranId,
    amountPaisa: 1000,
    intentId: randomUUID(),
    urls: {
      success: `${base}/public/payments/sslcommerz/smoke/return/${tranId}/success`,
      fail: `${base}/public/payments/sslcommerz/smoke/return/${tranId}/fail`,
      cancel: `${base}/public/payments/sslcommerz/smoke/return/${tranId}/cancel`,
      ipn: `${base}/public/payments/sslcommerz/smoke/ipn`,
    },
    customer: {
      name: 'Jantrik smoke test',
      phone: '01700000000',
      email: 'no-reply@jantrik.invalid',
      address: 'N/A',
      city: 'N/A',
      postcode: 'N/A',
      country: 'Bangladesh',
    },
  });
  if (session.kind !== 'OK') {
    log(`   Refused: ${session.code}`);
    return 1;
  }
  log(`   tran_id ${tranId}`);
  log(
    `   Open this page and pay (test card 4111 1111 1111 1111, 12/26, CVV 111; or mobile banking OTP 111111):`,
  );
  log(`   ${session.redirectUrl}`);
  log(
    '   (The page you land on afterwards may not load: that is expected without a public address.)',
  );

  log('3. Waiting for the payment (a query every 5 s, up to 5 minutes)…');
  let paid: ProviderAttempt | undefined;
  for (let i = 0; i < 60 && !paid; i++) {
    await deps.sleep(5000);
    const attempts = await provider.query(creds, tranId);
    if (!Array.isArray(attempts)) {
      log(`   Query failed: ${attempts.code}`);
      continue;
    }
    if (attempts.length > 0) log(`   ${attempts.map(describeAttempt).join('; ')}`);
    paid = attempts.find((a) => (a.status === 'VALID' || a.status === 'VALIDATED') && a.valId);
    if (
      !paid &&
      attempts.length > 0 &&
      attempts.every((a) => a.status === 'FAILED' || a.status === 'CANCELLED')
    ) {
      seen.push(
        `A failed or cancelled session shows in the query as: ${attempts.map((a) => a.status).join(', ')}.`,
      );
    }
  }
  if (!paid?.valId) {
    log('No payment within 5 minutes.');
    printSeen(seen, log);
    return 1;
  }

  log('4. The validation API:');
  const outcome = await provider.confirm(creds, { tranId, valId: paid.valId });
  if (outcome.kind !== 'PAID') {
    log(`   ${outcome.kind}${outcome.kind === 'ERROR' ? ` ${outcome.code}` : ''}`);
    printSeen(seen, log);
    return 1;
  }
  log(
    `   amount: ${outcome.amountPaisa ?? 'not a well-formed amount'} paisa (store amount ${outcome.storeAmountPaisa ?? '-'})`,
  );
  log(
    `   currency ${outcome.currency ?? '-'}, currency_type ${outcome.currencyType ?? '-'}, currency_amount ${outcome.currencyAmountPaisa ?? '-'} paisa`,
  );
  log(`   tran_id as returned: ${outcome.tranId === tranId ? 'ours' : 'DIFFERENT'}`);
  log(`   bank_tran_id: ${outcome.bankTranId ?? 'missing'}`);
  log(`   risk: ${outcome.risk}`);
  log(
    `   card_type ${outcome.instrument ?? '-'}, card_brand ${outcome.cardBrand ?? '-'} → method ${methodFromInstrument(outcome.instrument, outcome.cardBrand)}`,
  );
  log(
    `   tran_date read as Asia/Dhaka: ${outcome.paidAt?.toISOString() ?? 'not in the expected format'}`,
  );
  const again = await provider.confirm(creds, { tranId, valId: paid.valId });
  if (again.kind === 'PAID' && again.repeated) {
    seen.push('A second validation answers VALIDATED.');
  }
  if (outcome.amountPaisa === 1000)
    seen.push('The amount comes back as a decimal string ("10.00").');
  if (outcome.instrument) seen.push(`card_type for this payment: ${outcome.instrument}.`);
  printSeen(seen, log);
  return 0;
}

function printSeen(seen: string[], log: (line: string) => void) {
  log('What this run could see of the points the documentation leaves open:');
  for (const line of seen) log(`   - ${line}`);
  if (seen.length === 0) log('   (nothing)');
}

async function main(): Promise<void> {
  config({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });
  const start = smokeStart(process.env);
  if (start.kind === 'skip') {
    console.log(start.message);
    return;
  }
  if (start.kind === 'refuse') {
    console.error(start.message);
    process.exitCode = 1;
    return;
  }
  const provider = new SslcommerzProvider({
    apiPublicUrl: null,
    sslcommerzBaseUrl: start.baseUrl,
    timeoutMs: SSLCOMMERZ_TIMEOUT_MS,
  });
  process.exitCode = await runSmoke(start.creds, {
    provider,
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    returnBase: process.env['API_PUBLIC_URL'] || 'http://localhost:4000',
  });
}

/** Run by tsx as a command (not imported by a test). Paths compared without case (Windows). */
const entry = process.argv[1];
if (entry && path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  void main();
}

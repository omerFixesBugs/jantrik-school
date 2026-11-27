import { newTranId } from '@jantrik/shared';
import { SSLCOMMERZ_SANDBOX_URL, type PaymentsConfig } from '../src/payments/payments.config.js';
import type { CheckoutRequest, ProviderOutcome } from '../src/payments/provider.js';
import {
  isAllowedCheckoutUrl,
  SslcommerzProvider,
} from '../src/payments/sslcommerz/sslcommerz.provider.js';
import { startFakeSslcommerz, type FakeSslcommerz } from './support/fake-sslcommerz.js';

// The SSLCommerz client (sprint 1 P7a, docs/payments.md → The client), against the fake SSLCommerz
// on a port the OS picks. Nothing here reaches SSLCommerz itself.

const SENTINEL = 'Sentinel-Pw-7Q2x@ssl';
const creds = { storeId: 'jantrik0001', storePassword: SENTINEL };

describe('SslcommerzProvider', () => {
  let fake: FakeSslcommerz;
  let config: PaymentsConfig;
  let provider: SslcommerzProvider;

  const intent = (over: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
    tranId: newTranId(),
    amountPaisa: 125050,
    intentId: '0190a000-0000-7000-8000-000000000001',
    urls: {
      success: 'https://api.example.test/public/payments/sslcommerz/shapla/return/T/success',
      fail: 'https://api.example.test/public/payments/sslcommerz/shapla/return/T/fail',
      cancel: 'https://api.example.test/public/payments/sslcommerz/shapla/return/T/cancel',
      ipn: 'https://api.example.test/public/payments/sslcommerz/shapla/ipn',
    },
    customer: {
      name: 'Karim',
      phone: '01711000000',
      email: 'no-reply@jantrik.example',
      address: 'N/A',
      city: 'N/A',
      postcode: 'N/A',
      country: 'Bangladesh',
    },
    ...over,
  });

  /** A paid session: its tran_id and the attempt the fake recorded. */
  const paid = async (fields?: Record<string, string | undefined>) => {
    const request = intent();
    const session = await provider.createCheckout(creds, request);
    if (session.kind !== 'OK') throw new Error(`no session: ${session.code}`);
    return { tranId: request.tranId, attempt: fake.pay(session.sessionRef, { fields }) };
  };

  beforeAll(async () => {
    fake = await startFakeSslcommerz();
    fake.addStore(creds.storeId, creds.storePassword);
    fake.addStore('sleepy0001', 'sleepy0001@ssl', { active: false });
    config = { apiPublicUrl: null, sslcommerzBaseUrl: fake.url, timeoutMs: 30_000 };
    provider = new SslcommerzProvider(config);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await fake.close();
  });

  describe('createCheckout', () => {
    it('sends exactly the documented fields, the amount as a decimal and our addresses', async () => {
      const request = intent();
      const answer = await provider.createCheckout(creds, request);
      expect(answer).toMatchObject({ kind: 'OK' });
      const sent = fake.requests.findLast((r) => r.api === 'session')!;
      expect(sent.method).toBe('POST');
      expect(Object.keys(sent.fields).sort()).toEqual(
        [
          'store_id',
          'store_passwd',
          'total_amount',
          'currency',
          'tran_id',
          'success_url',
          'fail_url',
          'cancel_url',
          'ipn_url',
          'cus_name',
          'cus_email',
          'cus_add1',
          'cus_city',
          'cus_postcode',
          'cus_country',
          'cus_phone',
          'shipping_method',
          'product_name',
          'product_category',
          'product_profile',
          'emi_option',
          'value_a',
        ].sort(),
      );
      expect(sent.fields).toMatchObject({
        total_amount: '1250.50',
        currency: 'BDT',
        tran_id: request.tranId,
        success_url: request.urls.success,
        fail_url: request.urls.fail,
        cancel_url: request.urls.cancel,
        ipn_url: request.urls.ipn,
        shipping_method: 'NO',
        product_name: 'School fees',
        product_category: 'Education',
        product_profile: 'non-physical-goods',
        emi_option: '0',
        value_a: request.intentId,
        cus_phone: '01711000000',
      });
      // A form POST: the password in the body, never in the URL.
      expect(sent.path).toBe('/gwprocess/v4/api.php');
      expect(new URLSearchParams(sent.body).get('store_passwd')).toBe(SENTINEL);
    });

    it('SUCCESS → the payer page and the session key', async () => {
      const answer = await provider.createCheckout(creds, intent());
      if (answer.kind !== 'OK') throw new Error(answer.code);
      expect(answer.sessionRef).toMatch(/^SESS[0-9A-F]{16}$/);
      expect(answer.redirectUrl).toBe(`${fake.url}/pay/${answer.sessionRef}`);
      expect(fake.sessions.has(answer.sessionRef)).toBe(true);
    });

    it('FAILED → an error: AUTH_FAILED for bad credentials, else INVALID_REQUEST', async () => {
      expect(
        await provider.createCheckout({ ...creds, storePassword: 'wrong-password' }, intent()),
      ).toEqual({ kind: 'ERROR', code: 'AUTH_FAILED' });
      fake.override('session', { json: { status: 'FAILED', failedreason: 'Invalid amount' } });
      expect(await provider.createCheckout(creds, intent())).toEqual({
        kind: 'ERROR',
        code: 'INVALID_REQUEST',
      });
    });

    it('a payer page on another host, over http or without a session key → BAD_RESPONSE', async () => {
      for (const GatewayPageURL of [
        'https://evil.example/pay/X',
        'http://evil.example/pay/X',
        `${fake.url.replace('127.0.0.1', 'localhost')}/pay/X`,
        'javascript:alert(1)',
        '',
      ]) {
        fake.override('session', {
          json: { status: 'SUCCESS', sessionkey: 'SESSX', GatewayPageURL },
        });
        expect(await provider.createCheckout(creds, intent()), GatewayPageURL).toEqual({
          kind: 'ERROR',
          code: 'BAD_RESPONSE',
        });
      }
      fake.override('session', {
        json: { status: 'SUCCESS', GatewayPageURL: `${fake.url}/pay/X` },
      });
      expect(await provider.createCheckout(creds, intent())).toEqual({
        kind: 'ERROR',
        code: 'BAD_RESPONSE',
      });
    });

    it("against SSLCommerz itself, only SSLCommerz's own https pages", () => {
      const ok = [
        'https://sandbox.sslcommerz.com/EasyCheckOut/testcde5f8a1',
        'https://seamless-epay.sslcommerz.com/x',
        'https://SANDBOX.sslcommerz.com:443/x',
      ];
      const refused = [
        'http://sandbox.sslcommerz.com/EasyCheckOut/x',
        'https://sandbox.sslcommerz.com.evil.example/x',
        'https://evilsslcommerz.com/x',
        'https://sslcommerz.com.evil/x',
        'https://user@sandbox.sslcommerz.com/x',
        'https://sandbox.sslcommerz.com:8443/x',
        'not a url',
      ];
      for (const url of ok)
        expect(isAllowedCheckoutUrl(url, SSLCOMMERZ_SANDBOX_URL), url).toBe(true);
      for (const url of refused) {
        expect(isAllowedCheckoutUrl(url, SSLCOMMERZ_SANDBOX_URL), url).toBe(false);
      }
    });
  });

  describe('confirm (the validation API)', () => {
    it('VALID, then VALIDATED → PAID with every field', async () => {
      const { tranId, attempt } = await paid();
      const first = await provider.confirm(creds, { tranId, valId: attempt.valId });
      expect(first).toEqual({
        kind: 'PAID',
        repeated: false,
        tranId,
        valId: attempt.valId,
        amountPaisa: 125050,
        currency: 'BDT',
        currencyType: 'BDT',
        currencyAmountPaisa: 125050,
        storeAmountPaisa: 125050,
        bankTranId: attempt.fields['bank_tran_id'] ?? null,
        instrument: 'BKASH-BKash',
        cardBrand: 'MOBILEBANKING',
        risk: 'LOW',
        paidAt: new Date('2026-11-18T04:30:15.000Z'),
      } satisfies ProviderOutcome);
      const second = await provider.confirm(creds, { tranId, valId: attempt.valId });
      expect(second).toMatchObject({ kind: 'PAID', repeated: true, amountPaisa: 125050 });
      const sent = fake.requests.findLast((r) => r.api === 'validate')!;
      expect(sent.method).toBe('GET');
      expect(sent.fields).toEqual({
        val_id: attempt.valId,
        store_id: creds.storeId,
        store_passwd: SENTINEL,
        format: 'json',
      });
    });

    it('INVALID_TRANSACTION → INVALID (a made-up val_id, or another store)', async () => {
      expect(await provider.confirm(creds, { tranId: newTranId(), valId: 'VAL-made-up' })).toEqual({
        kind: 'INVALID',
      });
    });

    it('risk: "1" and a missing risk_level are HIGH; only "0" is LOW', async () => {
      for (const [risk_level, risk] of [
        ['1', 'HIGH'],
        [undefined, 'HIGH'],
        ['', 'HIGH'],
        ['0', 'LOW'],
      ] as const) {
        const { tranId, attempt } = await paid({ risk_level });
        expect(
          await provider.confirm(creds, { tranId, valId: attempt.valId }),
          String(risk_level),
        ).toMatchObject({ kind: 'PAID', risk });
      }
    });

    it('an amount that is not exactly a decimal is no amount (never read through a float)', async () => {
      const { tranId, attempt } = await paid({
        amount: '1,250.00',
        currency_amount: '1250.505',
        store_amount: '1e3',
      });
      expect(await provider.confirm(creds, { tranId, valId: attempt.valId })).toMatchObject({
        kind: 'PAID',
        amountPaisa: null,
        currencyAmountPaisa: null,
        storeAmountPaisa: null,
      });
      fake.override('validate', {
        json: { status: 'VALID', val_id: 'V1', tran_id: tranId, amount: 1250.5, risk_level: 0 },
      });
      expect(await provider.confirm(creds, { tranId, valId: 'V1' })).toMatchObject({
        kind: 'PAID',
        amountPaisa: null,
        risk: 'HIGH',
      });
    });

    it('reports the gateway tran_id and currencies as they were, for the caller to compare', async () => {
      const { tranId, attempt } = await paid({ currency: 'USD', currency_type: 'USD' });
      fake.transactions.at(-1)!.tranId = 'JSOTHER';
      expect(await provider.confirm(creds, { tranId, valId: attempt.valId })).toMatchObject({
        kind: 'PAID',
        tranId: 'JSOTHER',
        currency: 'USD',
        currencyType: 'USD',
      });
    });

    it('an answer for another val_id, bad credentials or an unknown status → an error', async () => {
      fake.override('validate', { json: { status: 'VALID', val_id: 'OTHER', amount: '10.00' } });
      expect(await provider.confirm(creds, { tranId: 'T', valId: 'MINE' })).toEqual({
        kind: 'ERROR',
        code: 'BAD_RESPONSE',
      });
      expect(
        await provider.confirm({ ...creds, storePassword: 'nope' }, { tranId: 'T', valId: 'V' }),
      ).toEqual({ kind: 'ERROR', code: 'AUTH_FAILED' });
      fake.override('validate', { json: { status: 'MAYBE' } });
      expect(await provider.confirm(creds, { tranId: 'T', valId: 'V' })).toEqual({
        kind: 'ERROR',
        code: 'BAD_RESPONSE',
      });
      for (const status of ['FAILED', 'CANCELLED', 'EXPIRED', 'PENDING'] as const) {
        fake.override('validate', { json: { status } });
        expect(await provider.confirm(creds, { tranId: 'T', valId: 'V' })).toEqual({
          kind: status,
        });
      }
    });
  });

  describe('query (the transaction query API)', () => {
    it('lists every attempt: a failed one, then a valid one', async () => {
      const request = intent();
      const session = await provider.createCheckout(creds, request);
      if (session.kind !== 'OK') throw new Error(session.code);
      fake.pay(session.sessionRef, { status: 'FAILED' });
      const valid = fake.pay(session.sessionRef);
      const attempts = await provider.query(creds, request.tranId);
      expect(Array.isArray(attempts) && attempts.map((a) => a.status)).toEqual(['FAILED', 'VALID']);
      expect(Array.isArray(attempts) && attempts[1]).toMatchObject({
        valId: valid.valId,
        tranId: request.tranId,
        amountPaisa: 125050,
        risk: 'LOW',
      });
      // Nothing for a transaction that never existed.
      expect(await provider.query(creds, newTranId())).toEqual([]);
    });

    it('APIConnect FAILED → AUTH_FAILED, INACTIVE → STORE_INACTIVE, INVALID_REQUEST, other', async () => {
      expect(await provider.query({ ...creds, storePassword: 'nope' }, newTranId())).toEqual({
        kind: 'ERROR',
        code: 'AUTH_FAILED',
      });
      expect(
        await provider.query({ storeId: 'sleepy0001', storePassword: 'sleepy0001@ssl' }, 'JSX'),
      ).toEqual({ kind: 'ERROR', code: 'STORE_INACTIVE' });
      fake.override('query', { json: { APIConnect: 'INVALID_REQUEST' } });
      expect(await provider.query(creds, 'JSX')).toEqual({
        kind: 'ERROR',
        code: 'INVALID_REQUEST',
      });
      fake.override('query', { json: { APIConnect: 'SOMETHING' } });
      expect(await provider.query(creds, 'JSX')).toEqual({ kind: 'ERROR', code: 'BAD_RESPONSE' });
      fake.override('query', { json: { no_of_trans_found: 0 } });
      expect(await provider.query(creds, 'JSX')).toEqual({ kind: 'ERROR', code: 'BAD_RESPONSE' });
    });

    it('testConnection: OK, BAD_CREDENTIALS, STORE_INACTIVE, UNREACHABLE, ERROR', async () => {
      expect(await provider.testConnection(creds)).toBe('OK');
      const asked = fake.requests.findLast((r) => r.api === 'query')!;
      expect(asked.fields['tran_id']).toMatch(/^JSTEST[0-9A-Z]{20}$/);
      expect(await provider.testConnection({ ...creds, storePassword: 'nope' })).toBe(
        'BAD_CREDENTIALS',
      );
      expect(
        await provider.testConnection({ storeId: 'sleepy0001', storePassword: 'sleepy0001@ssl' }),
      ).toBe('STORE_INACTIVE');
      fake.override('query', { status: 500 });
      expect(await provider.testConnection(creds)).toBe('ERROR');
      const down = new SslcommerzProvider({ ...config, sslcommerzBaseUrl: 'http://127.0.0.1:9' });
      expect(await down.testConnection(creds)).toBe('UNREACHABLE');
    });
  });

  describe('failures are fixed codes', () => {
    it('an answer after 31 s → TIMEOUT at 30 s (the client clock, no real waiting)', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      fake.override('query', {
        delayMs: 31_000,
        json: { APIConnect: 'DONE', no_of_trans_found: 0 },
      });
      let settled: unknown;
      const pending = provider.query(creds, 'JSX').then((v) => (settled = v));
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toEqual({ kind: 'ERROR', code: 'TIMEOUT' });
    });

    it('HTTP 500 → HTTP_STATUS; a redirect is never followed; HTML, malformed JSON → BAD_RESPONSE', async () => {
      fake.override('query', { status: 500, raw: 'Internal Server Error' });
      expect(await provider.query(creds, 'JSX')).toEqual({ kind: 'ERROR', code: 'HTTP_STATUS' });
      fake.override('validate', { status: 302, raw: '' });
      expect(await provider.confirm(creds, { tranId: 'T', valId: 'V' })).toEqual({
        kind: 'ERROR',
        code: 'HTTP_STATUS',
      });
      fake.override('session', { raw: '<html><body>Maintenance</body></html>' });
      expect(await provider.createCheckout(creds, intent())).toEqual({
        kind: 'ERROR',
        code: 'BAD_RESPONSE',
      });
      fake.override('query', { raw: '{"APIConnect":"DONE",' });
      expect(await provider.query(creds, 'JSX')).toEqual({ kind: 'ERROR', code: 'BAD_RESPONSE' });
      fake.override('query', { json: { APIConnect: 'DONE', element: 'not a list' } });
      expect(await provider.query(creds, 'JSX')).toEqual({ kind: 'ERROR', code: 'BAD_RESPONSE' });
      fake.override('query', { raw: `{"APIConnect":"DONE","x":"${'y'.repeat(300_000)}"}` });
      expect(await provider.query(creds, 'JSX')).toEqual({ kind: 'ERROR', code: 'BAD_RESPONSE' });
    });

    it('no answer, thrown or returned, carries the password, a URL or a body', async () => {
      const answers: unknown[] = [];
      const ask = async () => {
        answers.push(await provider.query(creds, 'JSX'));
        answers.push(await provider.confirm(creds, { tranId: 'T', valId: 'V' }));
        answers.push(await provider.createCheckout(creds, intent()));
      };
      for (const o of [{ status: 500, raw: `echo ${SENTINEL}` }, { raw: `<p>${SENTINEL}</p>` }]) {
        fake.override('query', o);
        fake.override('validate', o);
        fake.override('session', o);
        await ask();
      }
      fake.override('session', {
        json: { status: 'FAILED', failedreason: `bad password ${SENTINEL}` },
      });
      answers.push(await provider.createCheckout(creds, intent()));
      const down = new SslcommerzProvider({ ...config, sslcommerzBaseUrl: 'http://127.0.0.1:9' });
      answers.push(await down.query(creds, 'JSX'));
      for (const answer of answers) {
        const text = `${JSON.stringify(answer)} ${String(answer)}`;
        expect(text).not.toContain(SENTINEL);
        expect(text).not.toContain('127.0.0.1');
        expect(text).not.toContain('store_passwd');
        expect(text).not.toContain('Maintenance');
        expect(answer).toMatchObject({ kind: 'ERROR' });
      }
      // The positive control: the fake was sent the password.
      expect(fake.requests.some((r) => r.fields['store_passwd'] === SENTINEL)).toBe(true);
    });
  });
});

describe('the fake payer page', () => {
  it('Pay posts the IPN and sends the browser back to success_url with the fields', async () => {
    const fake = await startFakeSslcommerz();
    const ipns: string[] = [];
    const listener = await startFakeSslcommerz();
    try {
      fake.addStore(creds.storeId, creds.storePassword);
      const provider = new SslcommerzProvider({
        apiPublicUrl: null,
        sslcommerzBaseUrl: fake.url,
        timeoutMs: 30_000,
      });
      const tranId = newTranId();
      const session = await provider.createCheckout(creds, {
        tranId,
        amountPaisa: 1000,
        intentId: 'i-1',
        urls: {
          success: 'https://api.example.test/s',
          fail: 'https://api.example.test/f',
          cancel: 'https://api.example.test/c',
          // Another fake stands in for our IPN listener: it records the POST.
          ipn: `${listener.url}/ipn-here`,
        },
        customer: {
          name: 'G',
          phone: '01711000000',
          email: 'no-reply@example.test',
          address: 'N/A',
          city: 'N/A',
          postcode: 'N/A',
          country: 'Bangladesh',
        },
      });
      if (session.kind !== 'OK') throw new Error(session.code);
      const page = await fetch(session.redirectUrl);
      expect(await page.text()).toContain('10.00');
      const back = await fetch(`${session.redirectUrl}/pay`, { method: 'POST' });
      const html = await back.text();
      expect(html).toContain('action="https://api.example.test/s"');
      expect(html).toContain(`value="${tranId}"`);
      const ipn = listener.requests.find((r) => r.path === '/ipn-here')!;
      ipns.push(ipn.body);
      expect(ipn.fields).toMatchObject({ tran_id: tranId, status: 'VALID', amount: '10.00' });
      expect(ipn.fields['val_id']).toBeTruthy();
      expect(await provider.query(creds, tranId)).toMatchObject([{ status: 'VALID' }]);
    } finally {
      await fake.close();
      await listener.close();
    }
    expect(ipns).toHaveLength(1);
  });
});

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake SSLCommerz (sprint 1 P7a, docs/payments.md → Tests): the session, validation and
 * transaction query APIs with the documented shapes, and a payer page with "Pay", "Fail" and
 * "Cancel" that sends the payer's browser back and posts the IPN. The API tests start it on a
 * port the OS picks; Playwright runs it on its own (scripts/fake-sslcommerz.ts). Nothing here ever
 * calls the real SSLCommerz. It records every request it was sent (the sentinel tests' positive
 * control) and takes one-shot overrides for each API (a status, a delay, a body).
 *
 * Self-contained (node: built-ins only), so the stand-alone script can run it as it is.
 */

export type FakeApi = 'session' | 'validate' | 'query';

export interface FakeRequest {
  api: FakeApi | 'page' | 'other';
  method: string;
  path: string;
  /** The query string's and the form body's fields. */
  fields: Record<string, string>;
  /** The raw body, as received. */
  body: string;
}

export interface FakeOverride {
  /** Answer with this HTTP status (and `raw` or an empty JSON object). */
  status?: number;
  /** Wait this long before answering (the client's timeout test, with fake timers). */
  delayMs?: number;
  /** Answer with this text as it is (HTML, malformed JSON). */
  raw?: string;
  /** Answer with this JSON. */
  json?: unknown;
}

export interface FakeSession {
  sessionkey: string;
  storeId: string;
  fields: Record<string, string>;
}

/** One attempt at a session's payment, as the query and validation APIs report it. */
export interface FakeTransaction {
  storeId: string;
  tranId: string;
  valId: string;
  status: string;
  validatedCount: number;
  /** Every field reported for it (amount, currency, bank_tran_id, risk_level, …). */
  fields: Record<string, string | undefined>;
}

export interface FakeSslcommerz {
  /** `http://127.0.0.1:<port>` */
  url: string;
  requests: FakeRequest[];
  sessions: Map<string, FakeSession>;
  transactions: FakeTransaction[];
  /** Accept this store (and its password); `active: false` answers INACTIVE. */
  addStore(storeId: string, password: string, opts?: { active?: boolean }): void;
  /** The next answer of one API (a queue: each override is used once). */
  override(api: FakeApi, answer: FakeOverride): void;
  /**
   * A payment for a session: a VALID attempt (or `status`), with the session's amount unless
   * `fields` says otherwise (`risk_level: undefined` leaves it out).
   */
  pay(
    sessionkey: string,
    opts?: { status?: string; fields?: Record<string, string | undefined> },
  ): FakeTransaction;
  /** Whether the payer page posts the IPN (default true). */
  sendIpn: boolean;
  close(): Promise<void>;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** An HTML page that posts `fields` to `action` at once (the payer's browser going back). */
const autoPost = (action: string, fields: Record<string, string | undefined>) => `<!doctype html>
<html><body onload="document.forms[0].submit()">
<form method="post" action="${escapeHtml(action)}">
${Object.entries(fields)
  .filter(([, v]) => v !== undefined)
  .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v!)}">`)
  .join('\n')}
<button type="submit">Continue</button>
</form></body></html>`;

const id = (prefix: string) => `${prefix}${randomBytes(8).toString('hex')}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFakeSslcommerz(
  opts: { port?: number; host?: string } = {},
): Promise<FakeSslcommerz> {
  const stores = new Map<string, { password: string; active: boolean }>();
  const overrides: Record<FakeApi, FakeOverride[]> = { session: [], validate: [], query: [] };
  const requests: FakeRequest[] = [];
  const sessions = new Map<string, FakeSession>();
  const transactions: FakeTransaction[] = [];
  let url = '';

  /** null: accepted; else the store's problem. */
  const storeProblem = (fields: Record<string, string>): 'FAILED' | 'INACTIVE' | null => {
    const store = stores.get(fields['store_id'] ?? '');
    if (!store || store.password !== fields['store_passwd']) return 'FAILED';
    return store.active ? null : 'INACTIVE';
  };

  const reported = (t: FakeTransaction) => ({
    status: t.status,
    tran_id: t.tranId,
    val_id: t.valId,
    ...t.fields,
  });

  const fake: FakeSslcommerz = {
    url: '',
    requests,
    sessions,
    transactions,
    sendIpn: true,
    addStore(storeId, password, o = {}) {
      stores.set(storeId, { password, active: o.active ?? true });
    },
    override(api, answer) {
      overrides[api].push(answer);
    },
    pay(sessionkey, o = {}) {
      const session = sessions.get(sessionkey);
      if (!session) throw new Error(`fake SSLCommerz: no session ${sessionkey}`);
      const amount = session.fields['total_amount'] ?? '0.00';
      const t: FakeTransaction = {
        storeId: session.storeId,
        tranId: session.fields['tran_id'] ?? '',
        valId: id('VAL'),
        status: o.status ?? 'VALID',
        validatedCount: 0,
        fields: {
          tran_date: '2026-11-18 10:30:15',
          amount,
          store_amount: amount,
          currency: 'BDT',
          currency_type: 'BDT',
          currency_amount: amount,
          currency_rate: '1.0000',
          bank_tran_id: id('BTX'),
          card_type: 'BKASH-BKash',
          card_no: '01711XXXXXX',
          card_brand: 'MOBILEBANKING',
          risk_level: '0',
          risk_title: 'Safe',
          value_a: session.fields['value_a'],
          ...o.fields,
        },
      };
      transactions.push(t);
      return t;
    },
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // fetch keeps connections alive; a delayed answer may still be waiting.
      server.closeAllConnections();
      await closed;
    },
  };

  /** An override for `api`, applied; true when it answered. */
  const overridden = async (api: FakeApi, res: ServerResponse): Promise<boolean> => {
    const o = overrides[api].shift();
    if (!o) return false;
    if (o.delayMs) await sleep(o.delayMs);
    if (o.status === undefined && o.raw === undefined && o.json === undefined) return false;
    const status = o.status ?? 200;
    if (o.raw !== undefined) {
      res.writeHead(status, { 'Content-Type': 'text/html' });
      res.end(o.raw);
    } else {
      json(res, status, o.json ?? {});
    }
    return true;
  };

  const session = async (fields: Record<string, string>, res: ServerResponse) => {
    if (await overridden('session', res)) return;
    if (storeProblem(fields)) {
      json(res, 200, {
        status: 'FAILED',
        failedreason: 'Store Credential Error Or Store is De-active',
      });
      return;
    }
    const sessionkey = id('SESS').toUpperCase();
    sessions.set(sessionkey, { sessionkey, storeId: fields['store_id']!, fields });
    json(res, 200, {
      status: 'SUCCESS',
      failedreason: '',
      sessionkey,
      gw: { visa: 'city_visa', master: 'city_master' },
      redirectGatewayURL: `${url}/gwprocess/v4/bankgw/indexhtml.php?mamount=1`,
      GatewayPageURL: `${url}/pay/${sessionkey}`,
      storeBanner: `${url}/banner.png`,
      storeLogo: `${url}/logo.png`,
      desc: [],
      is_direct_pay_enable: '0',
    });
  };

  const validate = async (fields: Record<string, string>, res: ServerResponse) => {
    if (await overridden('validate', res)) return;
    const problem = storeProblem(fields);
    if (problem) {
      json(res, 200, { APIConnect: problem });
      return;
    }
    const t = transactions.find(
      (x) => x.valId === fields['val_id'] && x.storeId === fields['store_id'],
    );
    if (!t || (t.status !== 'VALID' && t.status !== 'VALIDATED')) {
      json(res, 200, { status: 'INVALID_TRANSACTION' });
      return;
    }
    t.validatedCount += 1;
    json(res, 200, {
      ...reported(t),
      status: t.validatedCount > 1 ? 'VALIDATED' : 'VALID',
      validated_on: '2026-11-18 10:30:40',
      emi_instalment: '0',
      card_issuer: 'BKash Mobile Banking',
      card_issuer_country: 'Bangladesh',
      card_issuer_country_code: 'BD',
      APIConnect: 'DONE',
    });
  };

  const query = async (fields: Record<string, string>, res: ServerResponse) => {
    if (await overridden('query', res)) return;
    const problem = storeProblem(fields);
    if (problem) {
      json(res, 200, { APIConnect: problem });
      return;
    }
    if (!fields['tran_id'] && !fields['sessionkey']) {
      json(res, 200, { APIConnect: 'INVALID_REQUEST' });
      return;
    }
    const found = transactions.filter(
      (t) => t.tranId === fields['tran_id'] && t.storeId === fields['store_id'],
    );
    json(res, 200, {
      APIConnect: 'DONE',
      no_of_trans_found: found.length,
      element: found.map(reported),
    });
  };

  /** The payer page and its three buttons. */
  const page = async (path: string, method: string, res: ServerResponse) => {
    const m = /^\/pay\/([A-Za-z0-9]+)(?:\/(pay|fail|cancel))?$/.exec(path);
    const s = m ? sessions.get(m[1]!) : undefined;
    if (!m || !s) {
      res.writeHead(404).end('no such session');
      return;
    }
    if (!m[2] || method !== 'POST') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="en"><head><title>Fake SSLCommerz</title></head><body>
<h1>Fake SSLCommerz (sandbox stand-in)</h1>
<p>Amount: <span id="amount">${escapeHtml(s.fields['total_amount'] ?? '')}</span> BDT</p>
${['pay', 'fail', 'cancel']
  .map(
    (a) =>
      `<form method="post" action="/pay/${s.sessionkey}/${a}"><button type="submit">${a[0]!.toUpperCase()}${a.slice(1)}</button></form>`,
  )
  .join('\n')}
</body></html>`);
      return;
    }
    const status = m[2] === 'pay' ? 'VALID' : m[2] === 'fail' ? 'FAILED' : 'CANCELLED';
    const t = fake.pay(s.sessionkey, { status });
    const ipnFields = {
      ...reported(t),
      store_id: s.storeId,
      verify_sign: id(''),
      verify_key: 'amount,bank_tran_id,card_type,currency,status,tran_id,val_id',
    };
    const target =
      m[2] === 'pay'
        ? s.fields['success_url']
        : m[2] === 'fail'
          ? s.fields['fail_url']
          : s.fields['cancel_url'];
    if (fake.sendIpn && s.fields['ipn_url']) {
      const body = new URLSearchParams(
        Object.entries(ipnFields).filter((e): e is [string, string] => e[1] !== undefined),
      );
      await fetch(s.fields['ipn_url'], { method: 'POST', body }).catch(() => undefined);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(autoPost(target ?? '/', ipnFields));
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const parsed = new URL(req.url ?? '/', 'http://fake');
        const fields: Record<string, string> = Object.fromEntries(parsed.searchParams);
        if (body && (req.headers['content-type'] ?? '').includes('form-urlencoded')) {
          Object.assign(fields, Object.fromEntries(new URLSearchParams(body)));
        }
        const path = parsed.pathname;
        const api: FakeRequest['api'] =
          path === '/gwprocess/v4/api.php'
            ? 'session'
            : path === '/validator/api/validationserverAPI.php'
              ? 'validate'
              : path === '/validator/api/merchantTransIDvalidationAPI.php'
                ? 'query'
                : path.startsWith('/pay/')
                  ? 'page'
                  : 'other';
        requests.push({ api, method: req.method ?? 'GET', path, fields, body });
        try {
          if (api === 'session' && req.method === 'POST') await session(fields, res);
          else if (api === 'validate' && req.method === 'GET') await validate(fields, res);
          else if (api === 'query' && req.method === 'GET') await query(fields, res);
          else if (api === 'page') await page(path, req.method ?? 'GET', res);
          else if (path === '/health') json(res, 200, { ok: true });
          else res.writeHead(404).end();
        } catch {
          if (!res.headersSent) res.writeHead(500).end();
        }
      })();
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve),
  );
  const address = server.address() as AddressInfo;
  url = `http://${opts.host ?? '127.0.0.1'}:${address.port}`;
  fake.url = url;
  return fake;
}

#!/usr/bin/env node
/**
 * The performance budget's measurement (docs/design.md → Performance budget): cold-cache, signed-in
 * loads on a 390 px phone with Chrome's CPU throttled 4× and the network at slow 4G, compared only
 * as an interleaved A/B (one run of each build in turn, the same API data).
 *
 * "Interactive" is the documented mark: the page's main content on screen, then 2 s without a
 * long task. It is the earliest time T at or after the content appeared such that no long task
 * runs inside (T, T + 2 s).
 *
 * Usage (both builds served at once, each against its own API on the same database and Redis):
 *   node apps/web/perf/measure.mjs \
 *     --side A=http://localhost:3200,http://localhost:4200 \
 *     --side B=http://localhost:3201,http://localhost:4201 \
 *     --pairs 6 --redis redis://localhost:6379/3 --out perf.json [--pages a,b]
 *
 * Logins go straight to each side's API from the browser context (password; the guardian by OTP
 * through the test SMS outbox, so the API must run with SMS_PROVIDER=outbox). Each run is a new
 * browser context: empty cache, its own cookies.
 */
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { Redis } from 'ioredis';

const PASSWORD = 'Jantrik@2026';
const USERS = {
  owner: { phone: '01711000001' },
  teacher: { phone: '01711000002' },
  accountant: { phone: '01711000004' },
  guardian: { phone: '01811000101', otp: true },
};

/** The six budget pages: who opens them and what "main content on screen" means for each. */
const PAGES = [
  {
    name: 'owner-dashboard',
    user: 'owner',
    path: '/dashboard',
    content: '[data-testid="dashboard-insight"]',
  },
  {
    name: 'students',
    user: 'owner',
    path: '/students',
    content: '[data-testid="students-cards"] > *, [data-testid="students-table"] tbody tr',
  },
  {
    name: 'take-attendance',
    user: 'teacher',
    path: '/attendance',
    content: '[data-testid="register-list"] button',
  },
  {
    name: 'fees-counter',
    user: 'accountant',
    path: '/fees',
    content: '[data-testid="fees-search"]',
  },
  {
    name: 'marks-entry',
    user: 'teacher',
    // Resolved once at start: the teacher's first open sheet (Annual exam, 6 ক Bangla).
    path: null,
    content: '[data-testid="sheet-row"]',
  },
  {
    name: 'guardian-dashboard',
    user: 'guardian',
    path: '/dashboard',
    content: '[data-testid="children"] > li',
  },
];

// Chrome DevTools "slow 4G" as docs/design.md defines it: 150 ms RTT, 1.6 Mbps down, 750 kbps up.
const NETWORK = {
  offline: false,
  latency: 150,
  downloadThroughput: (1.6 * 1_000_000) / 8,
  uploadThroughput: (750 * 1_000) / 8,
};
const CPU_RATE = 4;
const QUIET_MS = 2_000;
const RUN_TIMEOUT_MS = 45_000;

function parseArgs(argv) {
  const args = { sides: [], pairs: 6, pages: null, out: null, redis: 'redis://localhost:6379/3' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--side') {
      const [name, urls] = next().split('=');
      const [web, api] = urls.split(',');
      args.sides.push({ name, web, api });
    } else if (a === '--pairs') args.pairs = Number(next());
    else if (a === '--pages') args.pages = next().split(',');
    else if (a === '--out') args.out = next();
    else if (a === '--redis') args.redis = next();
    else throw new Error(`unknown argument ${a}`);
  }
  if (args.sides.length === 0) throw new Error('give at least one --side NAME=WEB,API');
  return args;
}

const e164 = (phone) => `+880${phone.slice(1)}`;

/** Signs the context in on `api` (sets the refresh cookie the web app restores the session from). */
async function signIn(context, side, user, redis) {
  const headers = { 'X-Jantrik-Client': 'web', Origin: side.web };
  const { phone, otp } = USERS[user];
  let res;
  if (otp) {
    const key = `sms:outbox:${e164(phone)}`;
    const before = await redis.lindex(key, -1);
    const req = await context.request.post(`${side.api}/auth/otp/request`, {
      data: { phone },
      headers,
    });
    if (req.status() !== 202) throw new Error(`otp request ${req.status()}`);
    let code;
    for (let i = 0; i < 50 && !code; i++) {
      const last = await redis.lindex(key, -1);
      if (last && last !== before) code = /\b(\d{6})\b/.exec(last)?.[1];
      else await new Promise((r) => setTimeout(r, 100));
    }
    if (!code) throw new Error('no OTP in the outbox (is SMS_PROVIDER=outbox?)');
    res = await context.request.post(`${side.api}/auth/otp/verify`, {
      data: { phone, code, client: 'web' },
      headers,
    });
  } else {
    res = await context.request.post(`${side.api}/auth/login`, {
      data: { identifier: phone, password: PASSWORD, client: 'web' },
      headers,
    });
  }
  if (res.status() !== 200) throw new Error(`login ${user} → ${res.status()}`);
  // The web app's readable "signed in" hint (auth-client.ts), as a signed-in phone has it;
  // without it proxy.ts sends the visit through /login first.
  await context.addCookies([{ name: 'jantrik_signed_in', value: '1', url: side.web }]);
}

function newContext(browser) {
  return browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    locale: 'bn-BD',
    timezoneId: 'Asia/Dhaka',
  });
}

/** Installed before any page script: long tasks, first paint, and when the content showed. */
const probe = (selector) => {
  const perf = { lt: [], contentAt: null };
  window.__perf = perf;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perf.lt.push([e.startTime, e.startTime + e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    perf.noLongTasks = true;
  }
  // Rendered (a box with a size): the phone layout hides the desktop table, and a long list
  // starts below the page's header on a phone.
  const rendered = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const check = () => {
    if (perf.contentAt !== null) return;
    if ([...document.querySelectorAll(selector)].some(rendered)) perf.contentAt = performance.now();
    else requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
};

/** The documented "interactive": the first T ≥ content with no long task inside (T, T + 2 s). */
export function interactiveAt(contentAt, longTasks) {
  let t = contentAt;
  const tasks = [...longTasks].sort((a, b) => a[0] - b[0]);
  for (const [start, end] of tasks) {
    if (end <= t) continue;
    if (start < t + QUIET_MS) t = Math.max(t, end);
    else break;
  }
  return t;
}

async function measureOnce(browser, side, page, redis) {
  const context = await newContext(browser);
  try {
    await signIn(context, side, page.user, redis);
    const tab = await context.newPage();
    await tab.addInitScript(probe, page.content);
    const cdp = await context.newCDPSession(tab);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', NETWORK);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });

    // Bytes on the wire by type, and the API calls' timing (relative to the navigation).
    const requests = new Map();
    let navStart = null;
    cdp.on('Network.requestWillBeSent', (e) => {
      if (navStart === null && e.type === 'Document') navStart = e.timestamp;
      requests.set(e.requestId, {
        url: e.request.url,
        method: e.request.method,
        start: e.timestamp,
      });
    });
    cdp.on('Network.responseReceived', (e) => {
      const r = requests.get(e.requestId);
      if (r) r.type = e.type;
    });
    cdp.on('Network.loadingFinished', (e) => {
      const r = requests.get(e.requestId);
      if (r) Object.assign(r, { end: e.timestamp, bytes: e.encodedDataLength });
    });

    await tab.goto(`${side.web}${page.path}`, { waitUntil: 'commit', timeout: RUN_TIMEOUT_MS });
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    let state;
    for (;;) {
      state = await tab.evaluate(() => ({
        contentAt: window.__perf?.contentAt ?? null,
        lt: window.__perf?.lt ?? [],
        now: performance.now(),
        fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
      }));
      if (state.contentAt !== null) {
        const t = interactiveAt(state.contentAt, state.lt);
        if (state.now >= t + QUIET_MS + 100) break;
      }
      if (Date.now() > deadline) throw new Error(`timeout (content ${state.contentAt})`);
      await new Promise((r) => setTimeout(r, 250));
    }
    const bytes = {};
    const api = [];
    for (const r of requests.values()) {
      const type = r.type ?? 'Other';
      bytes[type] = (bytes[type] ?? 0) + (r.bytes ?? 0);
      if (r.url.startsWith(side.api) && r.method !== 'OPTIONS' && r.end && navStart !== null) {
        api.push({
          path: new URL(r.url).pathname,
          start: Math.round((r.start - navStart) * 1000),
          end: Math.round((r.end - navStart) * 1000),
        });
      }
    }
    api.sort((a, b) => a.start - b.start);
    return {
      fcp: state.fcp,
      content: state.contentAt,
      interactive: interactiveAt(state.contentAt, state.lt),
      longTasks: state.lt.length,
      longTaskMs: Math.round(state.lt.reduce((s, [a, b]) => s + (b - a), 0)),
      bytes,
      api,
    };
  } finally {
    await context.close();
  }
}

/** Resolve the marks-entry URL: the teacher's first sheet link on /exams (unthrottled, once). */
async function resolveSheetPath(browser, side, redis) {
  const context = await newContext(browser);
  try {
    await signIn(context, side, 'teacher', redis);
    const tab = await context.newPage();
    await tab.goto(`${side.web}/exams`);
    const link = tab.locator('a[data-testid="my-sheet"]').first();
    await link.waitFor({ timeout: 30_000 });
    const href = await link.getAttribute('href');
    return new URL(href, side.web).pathname + new URL(href, side.web).search;
  } finally {
    await context.close();
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sec = (ms) => (ms / 1000).toFixed(2);
const kb = (b) => Math.round(b / 1024);

function summarize(results, sides, pages) {
  const lines = [
    '| Page | Build | Content on screen | Interactive | JS KB | Doc KB | Font KB | CSS KB | API calls |',
    '| ---- | ----- | ----------------- | ----------- | ----- | ------ | ------- | ------ | --------- |',
  ];
  for (const page of pages) {
    for (const side of sides) {
      const runs = results.filter((r) => r.page === page.name && r.side === side.name && !r.error);
      if (runs.length === 0) {
        lines.push(`| ${page.name} | ${side.name} | failed | failed | | | | | |`);
        continue;
      }
      const c = runs.map((r) => r.content);
      const i = runs.map((r) => r.interactive);
      const b = (type) => kb(median(runs.map((r) => r.bytes[type] ?? 0)));
      lines.push(
        `| ${page.name} | ${side.name} | ${sec(median(c))} s (${sec(Math.min(...c))}–${sec(Math.max(...c))}) | ` +
          `${sec(median(i))} s (${sec(Math.min(...i))}–${sec(Math.max(...i))}) | ${b('Script')} | ${b('Document')} | ` +
          `${b('Font')} | ${b('Stylesheet')} | ${median(runs.map((r) => r.api.length))} |`,
      );
    }
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pages = PAGES.filter((p) => !args.pages || args.pages.includes(p.name));
  const redis = new Redis(args.redis);
  const browser = await chromium.launch();
  const results = [];
  try {
    const sheet = pages.find((p) => p.name === 'marks-entry');
    if (sheet) sheet.path = await resolveSheetPath(browser, args.sides.at(-1), redis);
    for (let pair = 0; pair < args.pairs; pair++) {
      for (const page of pages) {
        // One run of each build in turn; the order alternates every pair.
        const order = pair % 2 === 0 ? args.sides : [...args.sides].reverse();
        for (const side of order) {
          try {
            const r = await measureOnce(browser, side, page, redis);
            results.push({ pair, page: page.name, side: side.name, ...r });
            console.log(
              `pair ${pair + 1} ${page.name} ${side.name}: content ${sec(r.content)} s, interactive ${sec(r.interactive)} s`,
            );
          } catch (error) {
            results.push({ pair, page: page.name, side: side.name, error: String(error) });
            console.log(`pair ${pair + 1} ${page.name} ${side.name}: FAILED ${error}`);
          }
        }
      }
    }
  } finally {
    await browser.close();
    await redis.quit();
  }
  const table = summarize(results, args.sides, pages);
  console.log(`\n${table}`);
  if (args.out) writeFileSync(args.out, JSON.stringify({ pages, results, table }, null, 2));
}

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('measure.mjs')
) {
  await main();
}

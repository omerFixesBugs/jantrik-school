import type { AuthResponse } from '@jantrik/shared';
import { vi } from 'vitest';
import type { Session } from './auth-client';

/**
 * Test-only: just enough of a browser for AuthClient and the boot refresh script
 * (boot-refresh.ts) in Vitest's Node environment. One shared cookie jar, Web Lock and
 * BroadcastChannel bus, so two clients (or a client and the script) behave like two tabs.
 */

type Listener = (event: { data: unknown }) => void;

/** Controllable fetch replies, in the order requests arrive. */
export interface Call {
  url: string;
  init: RequestInit;
  reply(status: number, body?: unknown): void;
  fail(): void;
}

export interface FakeBrowser {
  calls: Call[];
  /** Messages other tabs received, in order. */
  heard: unknown[];
  /** A channel in "another tab". */
  otherTab: { post(message: unknown): void };
  /** Hold the refresh lock from "another tab" until the returned function is called. */
  holdLock(): () => void;
  /** Most refresh calls ever in flight at the same time. */
  maxConcurrentRefreshes: () => number;
  cookie(): string;
  /** Let queued tasks and microtasks run. */
  settle(): Promise<void>;
  /** Wait until `n` fetches have been made. */
  untilCalls(n: number): Promise<void>;
}

/** Deliveries still queued by the current fake: cancelled when a test ends or a new fake starts. */
let pending: ReturnType<typeof setTimeout>[] = [];

/** Undo installFakeBrowser: drop queued deliveries, restore the globals. */
export function uninstallFakeBrowser(): void {
  pending.forEach(clearTimeout);
  pending = [];
  delete (globalThis as { __jantrikBoot?: unknown }).__jantrikBoot;
  vi.unstubAllGlobals();
}

export function installFakeBrowser(
  opts: { hint?: boolean; locks?: boolean; channel?: boolean } = {},
): FakeBrowser {
  const { hint = true, locks = true, channel = true } = opts;
  pending.forEach(clearTimeout);
  pending = [];

  // ── cookies ──
  const jar = new Map<string, string>();
  if (hint) jar.set('jantrik_signed_in', '1');
  const document = {
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(value: string) {
      const [pair = '', ...attrs] = value.split(';').map((s) => s.trim());
      const [name = '', v = ''] = pair.split('=');
      if (attrs.some((a) => /^max-age=0$/i.test(a))) jar.delete(name);
      else jar.set(name, v);
    },
    visibilityState: 'visible',
    addEventListener: () => undefined,
  };

  // ── Web Locks: one FIFO lock ──
  let tail: Promise<unknown> = Promise.resolve();
  const request = (_name: string, fn: () => unknown) => {
    const run = tail.then(() => fn());
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const holdLock = () => {
    let release!: () => void;
    void request('jantrik-refresh', () => new Promise<void>((r) => (release = r)));
    return () => release();
  };

  // ── BroadcastChannel: delivered to every other open instance, on a later task ──
  const open = new Set<FakeChannel>();
  const heard: unknown[] = [];
  class FakeChannel {
    private listeners: Listener[] = [];
    constructor(readonly name: string) {
      open.add(this);
    }
    addEventListener(_type: 'message', fn: Listener) {
      this.listeners.push(fn);
    }
    postMessage(data: unknown) {
      const copy = structuredClone(data);
      if (this !== other) heard.push(copy);
      for (const ch of open) {
        if (ch !== this && ch.name === this.name) {
          pending.push(setTimeout(() => ch.listeners.forEach((l) => l({ data: copy })), 0));
        }
      }
    }
    close() {
      open.delete(this);
    }
  }
  const other = new FakeChannel('jantrik-auth');

  // ── fetch ──
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = vi.fn((url: string, init: RequestInit = {}) => {
    const refresh = url.endsWith('/auth/refresh');
    if (refresh) maxInFlight = Math.max(maxInFlight, ++inFlight);
    return new Promise<Response>((resolve, reject) => {
      const done = () => {
        if (refresh) inFlight--;
      };
      calls.push({
        url,
        init,
        reply: (status, body) => {
          done();
          resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }));
        },
        fail: () => {
          done();
          reject(new TypeError('Failed to fetch'));
        },
      });
    });
  });

  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('document', document);
  vi.stubGlobal('location', { protocol: 'http:', hostname: 'localhost', pathname: '/dashboard' });
  vi.stubGlobal('navigator', locks ? { locks: { request } } : {});
  vi.stubGlobal('BroadcastChannel', channel ? FakeChannel : undefined);
  vi.stubGlobal('fetch', fetch);

  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return {
    calls,
    heard,
    otherTab: { post: (m) => other.postMessage(m) },
    holdLock,
    maxConcurrentRefreshes: () => maxInFlight,
    cookie: () => document.cookie,
    settle,
    untilCalls: async (n) => {
      for (let i = 0; i < 100 && calls.length < n; i++) await settle();
      if (calls.length < n) throw new Error(`expected ${n} fetches, saw ${calls.length}`);
    },
  };
}

const USER: AuthResponse['user'] = {
  id: 'u1',
  name: 'Rahim',
  nameBn: 'রহিম',
  locale: 'bn',
  colorScheme: 'SYSTEM',
};

/** A refresh response body. */
export const authBody = (token: string, tenantId = 't1'): AuthResponse => ({
  accessToken: token,
  expiresIn: 900,
  user: USER,
  tenant: { id: tenantId, name: 'School', slug: 'school' },
  roles: ['ADMIN'],
});

/** A session as another tab broadcasts it (`expiresIn` in ms). */
export const broadcastSession = (
  token: string,
  tenantId = 't1',
  expiresIn = 900_000,
): Omit<Session, 'receivedAt'> => ({
  accessToken: token,
  expiresAt: Date.now() + expiresIn,
  user: USER,
  tenant: { id: tenantId, name: 'School', slug: 'school' },
  roles: ['ADMIN'],
});

import {
  TENANT_HEADER,
  TENANT_MISMATCH,
  type AuthResponse,
  type AuthTenant,
  type Role,
} from '@jantrik/shared';
import { NetworkError, SignedOutError, TenantChangedError, toApiError } from '../api/errors';

/**
 * Browser session handling. See docs/auth.md → "Web client".
 *
 * - The access token lives ONLY in this object's memory (never localStorage / readable cookies).
 * - The refresh token is the API's httpOnly cookie; refreshes send `X-Jantrik-Client: web`.
 * - Refreshes are serialised across tabs with the Web Locks API, and the result is shared with
 *   other tabs over a BroadcastChannel, so two tabs never present the same refresh cookie.
 * - Tokens are refreshed ~60 s before expiry; a request that gets 401 is retried once.
 * - A page remembers the institute it was loaded for. If the session moves to another institute
 *   (switch in another tab), this tab blocks all API calls and asks the user to reload.
 */

const CONFIGURED_API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * The API's address. Production builds use NEXT_PUBLIC_API_URL exactly.
 *
 * In development, a localhost API URL follows the page's hostname instead (same port), so the
 * app also works when opened as http://<PC's LAN IP>:3000 on a phone: the refresh cookie is
 * SameSite=Strict, and localhost:3000 → 192.168.x.y:4000 would count as cross-site.
 */
function resolveApiUrl(): string {
  if (process.env.NODE_ENV !== 'development' || typeof window === 'undefined') {
    return CONFIGURED_API_URL;
  }
  const url = new URL(CONFIGURED_API_URL);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return CONFIGURED_API_URL;
  url.hostname = window.location.hostname;
  return url.origin;
}

export const API_URL = resolveApiUrl();

const LOCK_NAME = 'jantrik-refresh';
const CHANNEL_NAME = 'jantrik-auth';
/** Readable, non-secret hint so proxy.ts can skip rendering app pages for signed-out visitors. */
export const SIGNED_IN_HINT_COOKIE = 'jantrik_signed_in';

export interface Session {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
  user: AuthResponse['user'];
  tenant?: AuthTenant;
  roles?: Role[];
  /** Epoch ms when this tab received it (to tell whether another tab refreshed meanwhile). */
  receivedAt: number;
}

export type AuthEvent =
  | { type: 'session'; session: Session }
  | { type: 'signed-out' }
  | { type: 'tenant-changed'; tenant: AuthTenant | null };

type Message = { type: 'session'; session: Omit<Session, 'receivedAt'> } | { type: 'logout' };

export class AuthClient {
  private session: Session | null = null;
  private inflight: Promise<Session | null> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly channel: BroadcastChannel | null;
  private readonly listeners = new Set<(event: AuthEvent) => void>();
  /** Institute this page was loaded for; null on /login and /select-institute. */
  private pageTenantId: string | null = null;
  /** Set once the session moved to another institute: every API call is refused. */
  private tenantChanged = false;

  constructor() {
    this.channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME);
    this.channel?.addEventListener('message', (e: MessageEvent<Message>) => this.onMessage(e.data));
    document.addEventListener('visibilitychange', () => {
      // Timers are throttled in background tabs: catch up when the tab becomes visible.
      if (document.visibilityState === 'visible' && this.session && this.expiresWithin(90_000)) {
        void this.refresh().catch(() => undefined);
      }
    });
  }

  getSession(): Session | null {
    return this.session;
  }

  subscribe(listener: (event: AuthEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called by app pages once they know which institute they show. */
  setPageTenant(tenantId: string | null): void {
    this.pageTenantId = tenantId;
  }

  getPageTenant(): string | null {
    return this.pageTenantId;
  }

  /** Restore the session from the refresh cookie (first load, reload). */
  bootstrap(): Promise<Session | null> {
    return this.session ? Promise.resolve(this.session) : this.refresh();
  }

  /** Refresh the access token, serialised across tabs. Resolves null when signed out. */
  refresh(): Promise<Session | null> {
    if (this.inflight) return this.inflight;
    const startedAt = Date.now();
    this.inflight = this.withLock(async () => {
      // Another tab may have refreshed while we were waiting for the lock.
      const current = this.session;
      if (current && current.receivedAt > startedAt && !this.expiresWithin(90_000)) return current;

      let res: Response;
      try {
        res = await fetch(`${API_URL}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Jantrik-Client': 'web' },
          body: '{}',
        });
      } catch {
        throw new NetworkError();
      }
      if (res.status === 401) {
        this.signOutEverywhere();
        return null;
      }
      if (!res.ok) throw await toApiError(res);
      return this.adopt(fromResponse((await res.json()) as AuthResponse), { broadcast: true });
    }).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** POST a login endpoint (`/auth/otp/verify`, `/auth/login`) with `client: 'web'`. */
  async login(
    path: '/auth/otp/verify' | '/auth/login',
    body: Record<string, unknown>,
  ): Promise<Session> {
    const res = await rawFetch(`${API_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, client: 'web' }),
    });
    if (!res.ok) throw await toApiError(res);
    this.tenantChanged = false;
    return this.adopt(fromResponse((await res.json()) as AuthResponse), { broadcast: true });
  }

  /** Switch institute; the caller then navigates (full reload) to /dashboard. */
  async switchTenant(tenantId: string): Promise<Session> {
    const result = await this.api<{
      accessToken: string;
      expiresIn: number;
      tenant: AuthTenant;
      roles: Role[];
    }>('/auth/switch-tenant', { method: 'POST', json: { tenantId } });
    const base = this.session!;
    this.pageTenantId = result.tenant.id; // this tab follows the switch; other tabs are told
    return this.adopt(
      {
        ...base,
        accessToken: result.accessToken,
        expiresAt: Date.now() + result.expiresIn * 1000,
        tenant: result.tenant,
        roles: result.roles,
        receivedAt: Date.now(),
      },
      { broadcast: true },
    );
  }

  async logout(): Promise<void> {
    const token = this.session?.accessToken;
    if (token) {
      await rawFetch(`${API_URL}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    this.signOutEverywhere();
  }

  /**
   * Authenticated API call: Bearer token, the page's institute header, one retry after 401.
   * `json` is sent as the body; the parsed JSON response is returned (undefined for 204).
   */
  async api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    if (this.tenantChanged) throw new TenantChangedError();
    const send = async (session: Session) => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${session.accessToken}`);
      if (this.pageTenantId) headers.set(TENANT_HEADER, this.pageTenantId);
      if (init.json !== undefined) headers.set('Content-Type', 'application/json');
      return rawFetch(`${API_URL}${path}`, {
        ...init,
        headers,
        credentials: 'include',
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      });
    };

    let session = this.session && !this.expiresWithin(30_000) ? this.session : await this.refresh();
    if (!session) throw new SignedOutError();
    if (this.tenantChanged) throw new TenantChangedError();

    let res = await send(session);
    if (res.status === 401) {
      session = await this.refresh();
      if (!session) throw new SignedOutError();
      if (this.tenantChanged) throw new TenantChangedError();
      res = await send(session);
      if (res.status === 401) {
        this.signOutEverywhere();
        throw new SignedOutError();
      }
    }
    if (!res.ok) {
      const error = await toApiError(res);
      if (error.status === 409 && error.code === TENANT_MISMATCH) {
        this.markTenantChanged(this.session?.tenant ?? null);
        throw new TenantChangedError();
      }
      throw error;
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ── internals ──

  private adopt(session: Session, opts: { broadcast: boolean }): Session {
    this.session = session;
    setHintCookie(true);
    this.scheduleRefresh();
    if (opts.broadcast) {
      const { receivedAt: _r, ...shared } = session;
      this.channel?.postMessage({ type: 'session', session: shared } satisfies Message);
    }
    if (this.pageTenantId && session.tenant?.id !== this.pageTenantId) {
      // Never silently continue on another institute's data.
      this.markTenantChanged(session.tenant ?? null);
    }
    this.emit({ type: 'session', session });
    return session;
  }

  private markTenantChanged(tenant: AuthTenant | null): void {
    if (this.tenantChanged) return;
    this.tenantChanged = true;
    this.emit({ type: 'tenant-changed', tenant });
  }

  private onMessage(message: Message): void {
    if (message.type === 'logout') {
      this.clear();
      this.emit({ type: 'signed-out' });
    } else if (message.type === 'session') {
      this.adopt({ ...message.session, receivedAt: Date.now() }, { broadcast: false });
    }
  }

  private signOutEverywhere(): void {
    this.clear();
    this.channel?.postMessage({ type: 'logout' } satisfies Message);
    this.emit({ type: 'signed-out' });
  }

  private clear(): void {
    this.session = null;
    clearTimeout(this.timer);
    setHintCookie(false);
  }

  private scheduleRefresh(): void {
    clearTimeout(this.timer);
    if (!this.session) return;
    // ~60 s before expiry, with jitter so tabs don't all race for the lock at once.
    const delay = this.session.expiresAt - Date.now() - 60_000 - Math.random() * 10_000;
    this.timer = setTimeout(() => void this.refresh().catch(() => undefined), Math.max(delay, 0));
  }

  private expiresWithin(ms: number): boolean {
    return !this.session || this.session.expiresAt - Date.now() < ms;
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request(LOCK_NAME, fn) as Promise<T>;
    }
    return fn(); // older browsers: per-tab dedupe only (this.inflight)
  }

  private emit(event: AuthEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function fromResponse(body: AuthResponse): Session {
  return {
    accessToken: body.accessToken,
    expiresAt: Date.now() + body.expiresIn * 1000,
    user: body.user,
    tenant: body.tenant,
    roles: body.roles,
    receivedAt: Date.now(),
  };
}

async function rawFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new NetworkError();
  }
}

function setHintCookie(signedIn: boolean): void {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = signedIn
    ? `${SIGNED_IN_HINT_COOKIE}=1; Path=/; Max-Age=2592000; SameSite=Lax${secure}`
    : `${SIGNED_IN_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

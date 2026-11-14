import type { MeContext } from '@jantrik/shared';
import type { Session } from './auth-client';

/**
 * Start the session refresh while the JavaScript downloads (docs/plans/step-12-auth.md, part A;
 * docs/auth.md → Web client).
 *
 * A signed-in page used to wait for its bundles and hydration before `POST /auth/refresh`, then
 * for that before `GET /me/context`. The (app) layout inlines BOOT_REFRESH (below) into the HTML,
 * so both start while the bundles are still on their way; AuthClient and useMeContext take the
 * results over once (takeBootSession, takeBootMeContext).
 *
 * The script follows AuthClient's rules, because the refresh token rotates on every use and
 * presenting a rotated one again revokes the session:
 * - it runs only with the `jantrik_signed_in` hint and only where Web Locks and BroadcastChannel
 *   exist; otherwise it does nothing and AuthClient restores the session as before;
 * - it holds the `jantrik-refresh` Web Lock for its refresh, and reuses a session another tab
 *   broadcast while it waited for the lock instead of presenting the cookie;
 * - it broadcasts the session it got, as AuthClient does after a refresh;
 * - it keeps listening until AuthClient takes over: a logout from another tab beats its own
 *   session (which that logout probably revoked), and a later session from another tab beats
 *   anything before it.
 * The access token stays in memory (a closure and the hand-over), as with AuthClient.
 */

/** What the boot script hands AuthClient (`at`: when the script learned it, epoch ms). */
export type BootResult =
  | { type: 'session'; session: Omit<Session, 'receivedAt'>; at: number }
  /** The refresh answered 401: signed out. */
  | { type: 'signed-out'; at: number }
  /** Another tab signed out meanwhile. */
  | { type: 'logout'; at: number }
  /** Network error or another status: AuthClient restores the usual way. */
  | { type: 'error'; at: number };

/** `window.__jantrikBoot`, set by the script. Each function hands its result over once. */
export interface BootHandover {
  session(): Promise<BootResult> | null;
  /** The early `/me/context`, only for the access token it was fetched with; null on failure. */
  me(accessToken: string): Promise<MeContext | null> | null;
}

declare global {
  interface Window {
    __jantrikBoot?: BootHandover;
  }
}

/** Values that turn the boot refresh off (`JANTRIK_BOOT_REFRESH`, read at request time). */
const OFF = /^(off|false|0|no)$/i;

/** Whether the (app) layout inlines the script: on unless `JANTRIK_BOOT_REFRESH=off`. */
export function bootRefreshEnabled(setting: string | undefined): boolean {
  return !OFF.test((setting ?? '').trim());
}

/**
 * The inline script. `apiUrl` is the build's API address (CONFIGURED_API_URL); `followHost` is
 * set in development, where AuthClient makes a localhost API follow the page's hostname (a phone
 * on the LAN) and the script must call the same address. Plain ES5 (it may meet an old browser
 * before it checks for Web Locks) and no user input.
 */
export function bootRefreshScript(apiUrl: string, followHost: boolean): string {
  const config = JSON.stringify({ api: apiUrl, follow: followHost }).replace(/</g, '\\u003c');
  return `(function (c) {
  try {
    if (!/(?:^|;\\s*)jantrik_signed_in=1(?:;|$)/.test(document.cookie)) return;
    var nav = window.navigator;
    if (!nav || !nav.locks || typeof nav.locks.request !== 'function') return;
    if (typeof window.BroadcastChannel !== 'function' || typeof window.fetch !== 'function') return;
    var api = c.api;
    if (c.follow) {
      var u = new URL(api);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
        u.hostname = location.hostname;
        api = u.origin;
      }
    }
    var ch = new BroadcastChannel('jantrik-auth');
    // The newest thing known: this script's own outcome, or another tab's session or logout.
    var state = null;
    ch.addEventListener('message', function (e) {
      var m = e.data;
      if (m && m.type === 'logout') state = { type: 'logout', at: Date.now() };
      else if (m && m.type === 'session' && m.session) state = { type: 'session', session: m.session, at: Date.now() };
    });
    function settle(own) {
      own.at = Date.now();
      // A logout heard meanwhile wins (it probably revoked this session). Another tab's session
      // heard meanwhile wins over this script's failure (401 or error): that tab is signed in.
      if (state && (state.type === 'logout' || (state.type === 'session' && own.type !== 'session'))) return;
      state = own;
    }
    var me = null, meToken = null;
    var ready = nav.locks.request('jantrik-refresh', function () {
      // Another tab refreshed (or signed in) while this one waited: reuse its session rather than
      // present the cookie again, as AuthClient does. A logout heard meanwhile: nothing to do.
      if (state && state.type === 'logout') return null;
      if (state && state.type === 'session' && state.session.expiresAt - Date.now() >= 90000) return null;
      return fetch(api + '/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Jantrik-Client': 'web' },
        body: '{}'
      }).then(function (res) {
        if (res.status === 401) return { type: 'signed-out' };
        if (!res.ok) return { type: 'error' };
        return res.json().then(function (b) {
          // As fromResponse in auth-client.ts.
          var s = { accessToken: b.accessToken, expiresAt: Date.now() + b.expiresIn * 1000, user: b.user, tenant: b.tenant, roles: b.roles };
          // Not after a logout: the tabs that just signed out would take a revoked session.
          if (!(state && state.type === 'logout')) ch.postMessage({ type: 'session', session: s });
          return { type: 'session', session: s };
        });
      }).then(null, function () {
        return { type: 'error' };
      }).then(settle);
    }).then(function () {
      // The shell's next request, with the session's own token, while the bundles still load.
      if (state && state.type === 'session' && state.session.tenant) {
        meToken = state.session.accessToken;
        me = fetch(api + '/me/context', {
          credentials: 'include',
          headers: { Authorization: 'Bearer ' + meToken }
        }).then(function (res) {
          return res.ok ? res.json() : null;
        }).then(null, function () {
          return null;
        });
      }
    }, function () {
      if (!state) state = { type: 'error', at: Date.now() };
    });
    window.__jantrikBoot = {
      session: function () {
        var p = ready;
        ready = null;
        return p && p.then(function () {
          ch.close();
          return state || { type: 'error', at: Date.now() };
        });
      },
      me: function (token) {
        var p = me;
        me = null;
        return p && token === meToken ? p : null;
      }
    };
  } catch (e) {}
})(${config});`;
}

/** The boot script's session outcome, once; null when the script did not run or was taken. */
export function takeBootSession(): Promise<BootResult> | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.__jantrikBoot?.session() ?? null;
  } catch {
    return null;
  }
}

/**
 * The boot script's early `/me/context`, once, for this session and the page's institute only;
 * null otherwise (the caller then fetches it as usual).
 */
export async function takeBootMeContext(
  session: Pick<Session, 'accessToken'> | null,
  tenantId: string | null | undefined,
): Promise<MeContext | null> {
  if (typeof window === 'undefined' || !session || !tenantId) return null;
  let early: Promise<MeContext | null> | null = null;
  try {
    early = window.__jantrikBoot?.me(session.accessToken) ?? null;
  } catch {
    return null;
  }
  const context = await early?.catch(() => null);
  return context && context.tenant?.id === tenantId ? context : null;
}

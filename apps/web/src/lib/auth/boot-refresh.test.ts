import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authBody,
  broadcastSession,
  installFakeBrowser,
  uninstallFakeBrowser,
  type Call,
} from './fake-browser';
import {
  bootRefreshEnabled,
  bootRefreshFor,
  bootRefreshScript,
  takeBootMeContext,
  takeBootSession,
  type BootResult,
} from './boot-refresh';

const API = 'http://localhost:4000';
const run = (followHost = false) => new Function(bootRefreshScript(API, followHost))();
const context = (tenantId = 't1') => ({ tenant: { id: tenantId, name: 'School' }, labels: {} });

afterEach(uninstallFakeBrowser);

describe('the boot refresh script', () => {
  it.each([
    ['without the signed-in hint', { hint: false }],
    ['without Web Locks', { locks: false }],
    ['without BroadcastChannel', { channel: false }],
  ])('does nothing %s (AuthClient restores as before)', async (_, opts) => {
    const b = installFakeBrowser(opts);
    run();
    await b.settle();
    expect(b.calls).toEqual([]);
    expect(takeBootSession()).toBeNull();
  });

  it('refreshes under the lock, broadcasts the session, then fetches /me/context with its token', async () => {
    const b = installFakeBrowser();
    run();
    await b.untilCalls(1);
    const [refresh] = b.calls;
    expect(refresh!.url).toBe(`${API}/auth/refresh`);
    expect(refresh!.init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Jantrik-Client': 'web' },
      body: '{}',
    });

    // The lock is held for the refresh: another tab's refresh waits.
    let otherRan = false;
    void navigator.locks.request('jantrik-refresh', async () => {
      otherRan = true;
    });
    await b.settle();
    expect(otherRan).toBe(false);

    refresh!.reply(200, authBody('tok-1'));
    await b.untilCalls(2);
    expect(otherRan).toBe(true);
    expect(b.heard).toEqual([
      { type: 'session', session: expect.objectContaining({ accessToken: 'tok-1' }) },
    ]);
    const me = b.calls[1]!;
    expect(me.url).toBe(`${API}/me/context`);
    expect(me.init).toMatchObject({
      credentials: 'include',
      headers: { Authorization: 'Bearer tok-1' },
    });
    me.reply(200, context());

    const result = await takeBootSession();
    expect(result).toMatchObject({ type: 'session', session: { accessToken: 'tok-1' } });
    expect(takeBootSession()).toBeNull(); // once
    expect(await takeBootMeContext({ accessToken: 'tok-1' }, 't1')).toEqual(context());
    expect(await takeBootMeContext({ accessToken: 'tok-1' }, 't1')).toBeNull(); // once
  });

  it('hands the early /me/context only to the session it was fetched for, for that institute', async () => {
    const b = installFakeBrowser();
    run();
    await b.untilCalls(1);
    b.calls[0]!.reply(200, authBody('tok-1'));
    await b.untilCalls(2);
    b.calls[1]!.reply(200, context('t1'));
    await takeBootSession();
    expect(await takeBootMeContext({ accessToken: 'tok-2' }, 't1')).toBeNull();

    const c = installFakeBrowser();
    run();
    await c.untilCalls(1);
    c.calls[0]!.reply(200, authBody('tok-1'));
    await c.untilCalls(2);
    c.calls[1]!.reply(200, context('t1'));
    await takeBootSession();
    expect(await takeBootMeContext({ accessToken: 'tok-1' }, 't2')).toBeNull();
  });

  it('a failed early /me/context hands over nothing', async () => {
    const b = installFakeBrowser();
    run();
    await b.untilCalls(1);
    b.calls[0]!.reply(200, authBody('tok-1'));
    await b.untilCalls(2);
    b.calls[1]!.reply(500, { message: 'boom' });
    await takeBootSession();
    expect(await takeBootMeContext({ accessToken: 'tok-1' }, 't1')).toBeNull();
  });

  it('a 401 is "signed out": nothing broadcast, no /me/context', async () => {
    const b = installFakeBrowser();
    run();
    await b.untilCalls(1);
    b.calls[0]!.reply(401, { message: 'no session' });
    expect(await takeBootSession()).toMatchObject({ type: 'signed-out' });
    await b.settle();
    expect(b.calls).toHaveLength(1);
    expect(b.heard).toEqual([]);
  });

  it.each([
    ['a 5xx', (c: Call) => c.reply(503), 503],
    ['a 429', (c: Call) => c.reply(429), 429],
    ['a network error', (c: Call) => c.fail(), 0],
  ])('%s is an error with its status, for AuthClient to report', async (_, answer, status) => {
    const b = installFakeBrowser();
    run();
    await b.untilCalls(1);
    answer(b.calls[0]!);
    expect(await takeBootSession()).toMatchObject({ type: 'error', status });
    expect(b.heard).toEqual([]);
  });

  it('an unreadable answer is the script failing: an error without a status', async () => {
    const b = installFakeBrowser();
    run();
    await b.untilCalls(1);
    b.calls[0]!.reply(200); // no body
    const result = await takeBootSession();
    expect(result).toMatchObject({ type: 'error' });
    expect(result).not.toHaveProperty('status');
  });

  it("reuses another tab's session broadcast while it waited for the lock", async () => {
    const b = installFakeBrowser();
    const release = b.holdLock();
    run();
    b.otherTab.post({ type: 'session', session: broadcastSession('other-tok') });
    await b.settle();
    release();
    await b.untilCalls(1);
    expect(b.calls[0]!.url).toBe(`${API}/me/context`); // no refresh: the cookie is not presented
    expect(b.calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer other-tok' });
    expect(await takeBootSession()).toMatchObject({
      type: 'session',
      session: { accessToken: 'other-tok' },
    });
  });

  it('refreshes anyway when the broadcast session expires within 90 s', async () => {
    const b = installFakeBrowser();
    const release = b.holdLock();
    run();
    b.otherTab.post({ type: 'session', session: broadcastSession('old', 't1', 60_000) });
    await b.settle();
    release();
    await b.untilCalls(1);
    expect(b.calls[0]!.url).toBe(`${API}/auth/refresh`);
  });

  it('a logout heard while it waited for the lock: no refresh, "logout" handed over', async () => {
    const b = installFakeBrowser();
    const release = b.holdLock();
    run();
    b.otherTab.post({ type: 'logout' });
    await b.settle();
    release();
    expect(await takeBootSession()).toMatchObject({ type: 'logout' });
    expect(b.calls).toEqual([]);
  });

  it('a logout heard during its refresh beats the session that refresh returns', async () => {
    const b = installFakeBrowser();
    run();
    await b.untilCalls(1);
    b.otherTab.post({ type: 'logout' });
    await b.settle();
    b.calls[0]!.reply(200, authBody('tok-1'));
    expect(await takeBootSession()).toMatchObject({ type: 'logout' });
    await b.settle();
    expect(b.calls).toHaveLength(1); // no /me/context with a revoked token
    expect(b.heard).toEqual([]); // and the revoked session is not offered to the other tabs
  });

  it('a logout heard after its refresh, before the hand-over, wins too', async () => {
    const b = installFakeBrowser();
    run();
    await b.untilCalls(1);
    b.calls[0]!.reply(200, authBody('tok-1'));
    await b.untilCalls(2);
    b.otherTab.post({ type: 'logout' });
    await b.settle();
    expect(await takeBootSession()).toMatchObject({ type: 'logout' });
  });

  it("another tab's later session (an institute switch) beats its own", async () => {
    const b = installFakeBrowser();
    run();
    await b.untilCalls(1);
    b.calls[0]!.reply(200, authBody('tok-1', 't1'));
    await b.untilCalls(2);
    b.otherTab.post({ type: 'session', session: broadcastSession('tok-2', 't2') });
    await b.settle();
    const result = (await takeBootSession()) as Extract<BootResult, { type: 'session' }>;
    expect(result.session).toMatchObject({ accessToken: 'tok-2', tenant: { id: 't2' } });
    // The early /me/context belonged to tok-1 (institute t1): not handed to tok-2.
    expect(await takeBootMeContext({ accessToken: 'tok-2' }, 't2')).toBeNull();
  });

  it('an institute switch heard while its refresh is on its way beats its own session, which is not broadcast', async () => {
    const b = installFakeBrowser();
    run();
    await b.untilCalls(1);
    b.otherTab.post({ type: 'session', session: broadcastSession('tok-2', 't2') });
    await b.settle();
    b.calls[0]!.reply(200, authBody('tok-1', 't1'));
    await b.untilCalls(2);
    expect(b.calls[1]!.init.headers).toMatchObject({ Authorization: 'Bearer tok-2' });
    expect(await takeBootSession()).toMatchObject({
      type: 'session',
      session: { accessToken: 'tok-2', tenant: { id: 't2' } },
    });
    // The switching tab is not sent back to the old institute.
    expect(b.heard).toEqual([]);
  });

  it("another tab's session heard during a failed refresh beats the failure", async () => {
    const b = installFakeBrowser();
    run();
    await b.untilCalls(1);
    b.otherTab.post({ type: 'session', session: broadcastSession('tok-2') });
    await b.settle();
    b.calls[0]!.reply(401);
    expect(await takeBootSession()).toMatchObject({
      type: 'session',
      session: { accessToken: 'tok-2' },
    });
  });

  it('two tabs opening at once never have two refreshes in flight', async () => {
    const b = installFakeBrowser();
    run();
    const first = window.__jantrikBoot!;
    run();
    const second = window.__jantrikBoot!;
    await b.untilCalls(1);
    expect(b.calls[0]!.url).toBe(`${API}/auth/refresh`);
    await b.settle();
    expect(b.calls).toHaveLength(1); // the second waits for the lock
    b.calls[0]!.reply(200, authBody('tok-1'));
    await b.settle();
    // The second either reused the first's broadcast or refreshed after it, never alongside.
    for (const c of b.calls.filter((c) => c.url.endsWith('/auth/refresh') && c !== b.calls[0])) {
      c.reply(200, authBody('tok-2'));
    }
    for (const c of b.calls.filter((c) => c.url.endsWith('/me/context'))) c.reply(200, context());
    expect(await first.session()).toMatchObject({ type: 'session' });
    expect(await second.session()).toMatchObject({ type: 'session' });
    expect(b.maxConcurrentRefreshes()).toBe(1);
  });

  it('in development a localhost API follows the page host, as AuthClient does', async () => {
    const b = installFakeBrowser();
    vi.stubGlobal('location', { protocol: 'http:', hostname: '192.168.0.20', pathname: '/' });
    run(true);
    await b.untilCalls(1);
    expect(b.calls[0]!.url).toBe('http://192.168.0.20:4000/auth/refresh');
  });

  it('a `$` in the API address is taken literally', async () => {
    const b = installFakeBrowser();
    new Function(bootRefreshScript("https://api.example/$&$'x", false))();
    await b.untilCalls(1);
    expect(b.calls[0]!.url).toBe("https://api.example/$&$'x/auth/refresh");
  });

  it('keeps the configuration inside the script tag', () => {
    expect(bootRefreshScript('https://api.example/</script><script>x()', false)).not.toContain(
      '</script>',
    );
  });

  it('ships without its comments and indentation (it is sent twice)', () => {
    const script = bootRefreshScript(API, false);
    expect(script).not.toMatch(/^\s*\/\//m);
    expect(script).not.toMatch(/^[ \t]/m);
    expect(script.length).toBeLessThan(3000);
  });
});

describe('the switch (JANTRIK_BOOT_REFRESH)', () => {
  it('the layout gets no script when it is off, the script when it is on', () => {
    expect(bootRefreshFor('off', API, false)).toBeNull();
    expect(bootRefreshFor(undefined, API, false)).toBe(bootRefreshScript(API, false));
  });

  it.each([undefined, '', 'on', 'true', '1'])('%s: on', (value) => {
    expect(bootRefreshEnabled(value)).toBe(true);
  });
  it.each(['off', 'OFF', ' off ', 'false', '0', 'no'])('%s: off', (value) => {
    expect(bootRefreshEnabled(value)).toBe(false);
  });
});

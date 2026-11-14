import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthClient, type AuthEvent } from './auth-client';
import { bootRefreshScript, type BootHandover, type BootResult } from './boot-refresh';
import { authBody, broadcastSession, installFakeBrowser, type FakeBrowser } from './fake-browser';

const API = 'http://localhost:4000';
const runBootScript = () => new Function(bootRefreshScript(API, false))();
const refreshes = (b: FakeBrowser) => b.calls.filter((c) => c.url === `${API}/auth/refresh`);

function client() {
  const c = new AuthClient();
  const events: AuthEvent['type'][] = [];
  c.subscribe((e) => events.push(e.type));
  return { c, events };
}

afterEach(() => {
  delete (globalThis as { __jantrikBoot?: unknown }).__jantrikBoot;
  vi.unstubAllGlobals();
});

describe('AuthClient without the boot script (switched off, public pages): as before', () => {
  it('restores with its own refresh, broadcasts it and sets the hint', async () => {
    const b = installFakeBrowser({ hint: false });
    const { c, events } = client();
    const restored = c.bootstrap();
    await b.untilCalls(1);
    expect(b.calls[0]!.url).toBe(`${API}/auth/refresh`);
    b.calls[0]!.reply(200, authBody('tok-1'));
    expect(await restored).toMatchObject({ accessToken: 'tok-1' });
    expect(events).toEqual(['session']);
    expect(b.heard).toEqual([
      { type: 'session', session: expect.objectContaining({ accessToken: 'tok-1' }) },
    ]);
    expect(b.cookie()).toContain('jantrik_signed_in=1');
  });
});

describe('AuthClient taking over the boot refresh', () => {
  it('adopts the boot session with no second refresh and no second broadcast', async () => {
    const b = installFakeBrowser();
    runBootScript();
    await b.untilCalls(1);
    b.calls[0]!.reply(200, authBody('tok-1'));
    await b.untilCalls(2); // the early /me/context
    const { c, events } = client(); // the bundles arrive after the refresh answered
    const session = await c.bootstrap();
    expect(session).toMatchObject({
      accessToken: 'tok-1',
      user: { id: 'u1' },
      tenant: { id: 't1' },
      roles: ['ADMIN'],
    });
    expect(refreshes(b)).toHaveLength(1);
    expect(b.heard).toHaveLength(1); // the script's broadcast only
    expect(events).toEqual(['session']);
  });

  it('builds the same session from the boot refresh as from its own', async () => {
    const own = installFakeBrowser({ hint: false });
    const a = new AuthClient();
    const p = a.bootstrap();
    await own.untilCalls(1);
    own.calls[0]!.reply(200, authBody('tok-1'));
    const fromOwn = (await p)!;
    vi.unstubAllGlobals();

    const boot = installFakeBrowser();
    runBootScript();
    await boot.untilCalls(1);
    boot.calls[0]!.reply(200, authBody('tok-1'));
    const fromBoot = (await new AuthClient().bootstrap())!;
    const shape = (s: typeof fromOwn) => ({ ...s, expiresAt: 0, receivedAt: 0 });
    expect(shape(fromBoot)).toEqual(shape(fromOwn));
    expect(Math.abs(fromBoot.expiresAt - fromOwn.expiresAt)).toBeLessThan(5_000);
  });

  it('waits for a boot refresh still in flight instead of starting its own', async () => {
    const b = installFakeBrowser();
    runBootScript();
    await b.untilCalls(1);
    const { c } = client(); // the bundles were faster than the refresh
    const restored = c.bootstrap();
    await b.settle();
    expect(refreshes(b)).toHaveLength(1);
    b.calls[0]!.reply(200, authBody('tok-1'));
    expect(await restored).toMatchObject({ accessToken: 'tok-1' });
    expect(refreshes(b)).toHaveLength(1);
  });

  it('a boot 401 signs out everywhere, as its own 401 would', async () => {
    const b = installFakeBrowser();
    runBootScript();
    await b.untilCalls(1);
    b.calls[0]!.reply(401);
    const { c, events } = client();
    expect(await c.bootstrap()).toBeNull();
    expect(events).toEqual(['signed-out']);
    expect(b.heard).toEqual([{ type: 'logout' }]);
    expect(b.cookie()).not.toContain('jantrik_signed_in');
    expect(refreshes(b)).toHaveLength(1);
  });

  it('after a boot network error or 5xx it restores the usual way', async () => {
    const b = installFakeBrowser();
    runBootScript();
    await b.untilCalls(1);
    b.calls[0]!.fail();
    const { c } = client();
    const restored = c.bootstrap();
    await b.untilCalls(2);
    expect(b.calls[1]!.url).toBe(`${API}/auth/refresh`);
    b.calls[1]!.reply(200, authBody('tok-2'));
    expect(await restored).toMatchObject({ accessToken: 'tok-2' });
  });

  it('a boot "logout" (another tab signed out) signs this tab out without broadcasting', async () => {
    const b = installFakeBrowser();
    runBootScript();
    await b.untilCalls(1);
    b.otherTab.post({ type: 'logout' });
    await b.settle();
    b.calls[0]!.reply(200, authBody('tok-1'));
    const { c, events } = client();
    expect(await c.bootstrap()).toBeNull();
    expect(events).toEqual(['signed-out']);
    expect(c.getSession()).toBeNull();
    expect(b.heard.filter((m) => (m as { type: string }).type === 'logout')).toEqual([]);
  });

  it('what its own channel heard before the hand-over wins over the boot result', async () => {
    const b = installFakeBrowser();
    // A hand-over whose result arrives late, after this tab's client already heard a logout
    // (the two channels of one tab receive a message as separate tasks).
    let resolve!: (r: BootResult) => void;
    const handover: BootHandover = {
      session: () => new Promise<BootResult>((r) => (resolve = r)),
      me: () => null,
    };
    window.__jantrikBoot = handover;
    const { c, events } = client();
    const restored = c.bootstrap();
    b.otherTab.post({ type: 'logout' });
    await b.settle();
    resolve({ type: 'session', session: broadcastSession('tok-1'), at: Date.now() });
    expect(await restored).toBeNull();
    expect(c.getSession()).toBeNull();
    expect(events).toEqual(['signed-out']);
  });

  it("another tab's session heard before the hand-over is the one kept", async () => {
    const b = installFakeBrowser();
    let resolve!: (r: BootResult) => void;
    window.__jantrikBoot = {
      session: () => new Promise<BootResult>((r) => (resolve = r)),
      me: () => null,
    };
    const { c } = client();
    const restored = c.bootstrap();
    b.otherTab.post({ type: 'session', session: broadcastSession('tok-2', 't2') });
    await b.settle();
    resolve({ type: 'session', session: broadcastSession('tok-1', 't1'), at: Date.now() });
    expect(await restored).toMatchObject({ accessToken: 'tok-2', tenant: { id: 't2' } });
  });

  it('takes the boot result once: later refreshes go to the API', async () => {
    const b = installFakeBrowser();
    runBootScript();
    await b.untilCalls(1);
    b.calls[0]!.reply(200, authBody('tok-1'));
    const { c } = client();
    await c.bootstrap();
    const again = c.refresh();
    await b.settle();
    const second = refreshes(b)[1]!;
    expect(second).toBeDefined();
    second.reply(200, authBody('tok-2'));
    expect(await again).toMatchObject({ accessToken: 'tok-2' });
  });
});

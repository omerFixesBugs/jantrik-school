import { expect, test, type Page, type Request } from '@playwright/test';
import { API_URL, DEMO, logout, passwordLogin } from './helpers';

// The boot refresh (src/lib/auth/boot-refresh.ts; docs/auth.md → Web client): an inline script in
// the institute app's HTML starts POST /auth/refresh and GET /me/context while the JavaScript
// downloads, and AuthClient takes the results over. These cover where it runs, the hand-over,
// and the races the plan lists (docs/plans/step-12-auth.md → Risks).

const WEB = 'http://localhost:3000';

/** This page's calls to the refresh and context endpoints. */
function track(page: Page) {
  const refreshes: Request[] = [];
  const contexts: Request[] = [];
  page.on('request', (r) => {
    if (r.url() === `${API_URL}/auth/refresh` && r.method() === 'POST') refreshes.push(r);
    if (r.url() === `${API_URL}/me/context` && r.method() === 'GET') contexts.push(r);
  });
  return { refreshes, contexts };
}

/**
 * Hold this page's JavaScript until `release()`: the HTML (and the boot script in it) runs,
 * AuthClient does not exist yet. Not the CSS: an inline script waits for the stylesheets.
 */
async function holdBundles(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route('**/_next/static/**', async (route) => {
    if (route.request().resourceType() === 'script') await gate;
    await route.continue();
  });
  return release;
}

test('the script is in the institute app only: not on the login, platform or institute picker pages', async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: 'jantrik_signed_in', value: '1', url: WEB }]);
  const html = async (path: string) => (await page.request.get(path)).text();
  expect(await html('/dashboard')).toContain('id="boot-refresh"');
  expect(await html('/students')).toContain('id="boot-refresh"');
  for (const path of ['/login', '/platform/login', '/select-institute']) {
    expect(await html(path), path).not.toContain('id="boot-refresh"');
  }
});

test('a reload restores through the boot refresh: one refresh, one /me/context', async ({
  page,
}) => {
  await passwordLogin(page, DEMO.aloOwner);
  await expect(page.getByTestId('institute-name')).toHaveText(DEMO.aloName);
  const calls = track(page);
  await page.reload();
  await expect(page.getByTestId('institute-name')).toHaveText(DEMO.aloName);
  await page.waitForLoadState('networkidle');
  expect(calls.refreshes).toHaveLength(1);
  // The boot script's (no institute header): AuthClient and the shell took it over.
  expect(calls.contexts).toHaveLength(1);
  expect(calls.contexts[0]!.headers()['x-jantrik-tenant']).toBeUndefined();
});

test('two tabs opened together: the refreshes never overlap and the session survives', async ({
  context,
}) => {
  const first = await context.newPage();
  await passwordLogin(first, DEMO.shaplaOwner);
  await expect(first.getByTestId('institute-name')).toHaveText(DEMO.shaplaName);

  const tabs = [await context.newPage(), await context.newPage()];
  const calls = tabs.map(track);
  await Promise.all(tabs.map((tab) => tab.goto('/dashboard')));
  for (const tab of tabs) {
    await expect(tab.getByTestId('institute-name')).toHaveText(DEMO.shaplaName);
  }

  const refreshes = calls.flatMap((c) => c.refreshes);
  expect(refreshes.length).toBeGreaterThanOrEqual(1);

  // No refresh token was presented twice. (The API would not notice within its 30 s retry
  // window, so read what each request sent.)
  const seen = await Promise.all(
    refreshes.map(async (r) => {
      const response = await r.response();
      const t = r.timing();
      return {
        token: /jantrik_rt=([^;]+)/.exec((await r.allHeaders())['cookie'] ?? '')?.[1]?.slice(0, 12),
        status: response?.status(),
        start: t.startTime,
        end: t.startTime + t.responseEnd,
      };
    }),
  );
  const report = JSON.stringify(seen);
  expect(
    seen.every((s) => s.token),
    report,
  ).toBe(true);
  const inOrder = [...seen].sort((a, b) => a.start - b.start);
  // A token the API accepted (and so rotated) is never presented again. (After a failed attempt
  // the same token is still current, so a retry may present it.)
  const rotated = new Set<string>();
  for (const s of inOrder) {
    expect(rotated.has(s.token!), report).toBe(false);
    if (s.status === 200) rotated.add(s.token!);
  }

  // Each refresh ran alone (the Web Lock): one ended before the next started.
  for (let i = 1; i < inOrder.length; i++) {
    expect(inOrder[i]!.start, report).toBeGreaterThanOrEqual(inOrder[i - 1]!.end);
  }

  // And the session still works after both.
  await tabs[0]!.reload();
  await expect(tabs[0]!.getByTestId('institute-name')).toHaveText(DEMO.shaplaName);
});

test('a logout in another tab while the boot refresh is on its way signs this tab out', async ({
  context,
}) => {
  const first = await context.newPage();
  await passwordLogin(first, DEMO.aloOwner);
  await expect(first.getByTestId('institute-name')).toHaveText(DEMO.aloName);

  const second = await context.newPage();
  const calls = track(second);
  const releaseBundles = await holdBundles(second);
  // The refresh reaches the API (and succeeds) before the logout; its answer arrives after it.
  let answer!: () => Promise<void>;
  const refreshed = new Promise<void>((resolve) => {
    void second.route(`${API_URL}/auth/refresh`, async (route) => {
      const response = await route.fetch();
      answer = () => route.fulfill({ response });
      resolve();
    });
  });
  await second.goto('/dashboard', { waitUntil: 'commit' });
  await refreshed;

  await logout(first);
  await expect(first).toHaveURL(/\/login/);
  await answer();
  releaseBundles();

  await expect(second).toHaveURL(/\/login/);
  expect(calls.refreshes).toHaveLength(1);
  // Neither the script nor AuthClient went on with the revoked session.
  expect(calls.contexts).toHaveLength(0);
  await expect(second.getByTestId('institute-name')).toHaveCount(0);
});

test('an institute switch in another tab while this one loads: it follows the switch', async ({
  context,
}) => {
  const first = await context.newPage();
  await passwordLogin(first, DEMO.sharedTeacher);
  await first.getByRole('button', { name: DEMO.shaplaName }).click();
  await expect(first.getByTestId('institute-name')).toHaveText(DEMO.shaplaName);

  // The second tab's boot refresh and early /me/context finish for Shapla while its JavaScript
  // still loads; then the first tab switches to Alo.
  const second = await context.newPage();
  const calls = track(second);
  const releaseBundles = await holdBundles(second);
  const earlyContext = second.waitForResponse(`${API_URL}/me/context`);
  await second.goto('/dashboard', { waitUntil: 'commit' });
  expect((await (await earlyContext).json()).tenant.name).toBe(DEMO.shaplaName);

  await first.getByTestId('user-menu').click();
  await first.getByRole('menuitem', { name: 'প্রতিষ্ঠান পরিবর্তন' }).click();
  await first.getByRole('button', { name: DEMO.aloName }).click();
  await expect(first.getByTestId('institute-name')).toHaveText(DEMO.aloName);

  releaseBundles();
  // Never Shapla's context under Alo's session: the early one is dropped, Alo's is fetched.
  await expect(second.getByTestId('institute-name')).toHaveText(DEMO.aloName);
  await expect(second.getByTestId('tenant-changed-dialog')).toHaveCount(0);
  expect(calls.contexts).toHaveLength(2);
  expect(calls.contexts[1]!.headers()['x-jantrik-tenant']).toBeDefined();
});

for (const [name, cookies] of [
  ['a forged signed-in hint (no session cookie)', []],
  [
    'a stale one (a refresh cookie the API does not know)',
    [{ name: 'jantrik_rt', value: 'stale-token', domain: 'localhost', path: '/auth' }],
  ],
] as const) {
  test(`${name}: one refresh, then the login page`, async ({ page, context }) => {
    await context.addCookies([
      { name: 'jantrik_signed_in', value: '1', url: WEB },
      ...cookies.map((c) => ({ ...c })),
    ]);
    const calls = track(page);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
    await page.waitForLoadState('networkidle');
    expect(calls.refreshes).toHaveLength(1);
    expect(calls.contexts).toHaveLength(0);
    const hint = (await context.cookies(WEB)).find((c) => c.name === 'jantrik_signed_in');
    expect(hint).toBeUndefined();
  });
}

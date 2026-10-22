import { expect, test } from '@playwright/test';
import { API_URL, DEMO, apiLogin, logout, passwordLogin } from './helpers';

test('switching institute in another tab blocks this tab until it reloads', async ({ context }) => {
  const first = await context.newPage();
  await passwordLogin(first, DEMO.sharedTeacher);
  await first.getByRole('button', { name: DEMO.shaplaName }).click();
  await expect(first.getByTestId('institute-name')).toHaveText(DEMO.shaplaName);

  // Same browser session in a second tab, which switches to the coaching centre.
  const second = await context.newPage();
  await second.goto('/dashboard');
  await expect(second.getByTestId('institute-name')).toHaveText(DEMO.shaplaName);
  await second.getByTestId('user-menu').click();
  await second.getByRole('menuitem', { name: 'প্রতিষ্ঠান পরিবর্তন' }).click();
  await second.getByRole('button', { name: DEMO.aloName }).click();
  await expect(second.getByTestId('institute-name')).toHaveText(DEMO.aloName);

  // The first tab must not silently continue: blocking dialog naming the new institute.
  const dialog = first.getByTestId('tenant-changed-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(DEMO.aloName);
  await dialog.getByRole('button', { name: 'ঠিক আছে, পাতা লোড করুন' }).click();
  await expect(first).toHaveURL(/\/dashboard$/);
  await expect(first.getByTestId('institute-name')).toHaveText(DEMO.aloName);
});

test('a TENANT_MISMATCH (409) from the API also blocks the page', async ({ page }) => {
  // The dashboard's own /students requests (the summary, and the setup checklist's once the day's
  // report is in) finish first: the stale header goes on the students page's.
  const dashboard = Promise.all(
    ['/students/summary', '/students/filters', '/students?pageSize=1'].map((path) =>
      page.waitForResponse((r) => r.url().startsWith(`${API_URL}${path}`)),
    ),
  );
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page.getByTestId('institute-name')).toHaveText(DEMO.shaplaName);
  await dashboard;

  // Simulate a stale page: its institute header no longer matches the session.
  await page.route(`${API_URL}/students**`, async (route) => {
    const headers = { ...route.request().headers(), 'x-jantrik-tenant': crypto.randomUUID() };
    await route.continue({ headers });
  });
  await page.getByRole('link', { name: 'শিক্ষার্থী তালিকা' }).click();
  await expect(page.getByTestId('tenant-changed-dialog')).toBeVisible();
});

test('API: X-Jantrik-Tenant must match the token (409 TENANT_MISMATCH)', async () => {
  const token = await apiLogin(DEMO.shaplaOwner);
  const ok = await fetch(`${API_URL}/students`, { headers: { Authorization: `Bearer ${token}` } });
  expect(ok.status).toBe(200);
  const mismatch = await fetch(`${API_URL}/students`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Jantrik-Tenant': crypto.randomUUID() },
  });
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({ code: 'TENANT_MISMATCH' });
});

test('logout in one tab signs out every tab', async ({ context }) => {
  const first = await context.newPage();
  await passwordLogin(first, DEMO.aloOwner);
  await expect(first).toHaveURL(/\/dashboard$/);
  const second = await context.newPage();
  await second.goto('/students');
  await expect(second.getByTestId('institute-name')).toHaveText(DEMO.aloName);

  await logout(second);
  await expect(second).toHaveURL(/\/login/);
  await expect(first).toHaveURL(/\/login/);
});

test('a page reload restores the session from the httpOnly cookie (token is memory-only)', async ({
  page,
}) => {
  await passwordLogin(page, DEMO.aloOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toMatch(/eyJ/); // no JWT in web storage
  await page.reload();
  await expect(page.getByTestId('institute-name')).toHaveText(DEMO.aloName);
});

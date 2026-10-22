import { expect, test, type Page } from '@playwright/test';
import { DEMO, passwordLogin } from './helpers';

// The keyboard layer (docs/design.md → Principles 8): Ctrl/⌘ K finds students, pages and
// actions; `?`, `/` and `g` + letter work anywhere outside a field. What it offers follows the
// person's role, like the sidebar and the API.

const palette = (page: Page) => page.getByTestId('command-palette');
const box = (page: Page) => palette(page).getByRole('combobox');

/** The shell (and with it the keyboard layer) is up once its search button shows. */
async function shellReady(page: Page) {
  await expect(page.getByTestId('palette-button')).toBeVisible();
}

async function openPalette(page: Page) {
  await shellReady(page);
  await page.keyboard.press('Control+KeyK');
  await expect(palette(page)).toBeVisible();
}

test('Ctrl+K finds a student by name and by a Bangla-digit phone, opens pages, remembers', async ({
  page,
}) => {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);

  await openPalette(page);
  await box(page).fill('তাসনিম');
  const tasnim = palette(page).getByRole('option', { name: /তাসনিম রহমান/ });
  await expect(tasnim).toBeVisible();
  await expect(tasnim).toContainText('SHS-2026-0001'); // IDs stay ASCII
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/students\/[0-9a-f-]{36}$/);
  await expect(palette(page)).toHaveCount(0);

  // The guardian's phone typed on a Bangla keyboard finds both of their children.
  await openPalette(page);
  await box(page).fill('০১৮১১০০০১০১');
  await expect(palette(page).getByRole('option', { name: /তাহমিদ রহমান/ })).toBeVisible();
  await expect(palette(page).getByRole('option', { name: /তাসনিম রহমান/ })).toBeVisible();

  // A page by name; Enter opens the first match.
  await box(page).fill('রেজিস্টার');
  await expect(palette(page).getByRole('option', { name: 'মাসিক হাজিরা রেজিস্টার' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/attendance\/register/);

  // Opened records come back first, before typing anything.
  await openPalette(page);
  await expect(
    palette(page).getByRole('group', { name: 'সম্প্রতি খোলা' }).getByRole('option'),
  ).toContainText(['তাসনিম রহমান']);
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);

  // The top bar's search opens the same palette.
  await page.getByTestId('palette-button').click();
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Escape');
});

test('shortcuts: ? lists them, g s goes to the students, / reaches the page search', async ({
  page,
}) => {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);
  await shellReady(page);
  await page.keyboard.press('Shift+Slash');
  await expect(page.getByTestId('shortcuts-dialog')).toBeVisible();
  // Nothing fires behind an open dialog.
  await page.keyboard.press('KeyG');
  await page.keyboard.press('KeyS');
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0);

  await page.keyboard.press('KeyG');
  await page.keyboard.press('KeyS');
  await expect(page).toHaveURL(/\/students$/);
  await expect(page.getByTestId('students-table')).toBeVisible();
  await page.keyboard.press('Slash');
  await expect(page.locator('[data-page-search]')).toBeFocused();
  // Typing in a field never triggers a shortcut: "gs" stays text.
  await page.keyboard.type('gs');
  await expect(page).toHaveURL(/\/students(\?.*)?$/);
  await expect(page.locator('[data-page-search]')).toHaveValue('gs');
});

test("a teacher's palette offers only what a teacher may do", async ({ page }) => {
  await passwordLogin(page, DEMO.shaplaTeacher);
  await expect(page).toHaveURL(/\/dashboard$/);
  await openPalette(page);
  await box(page).fill('ভর্তি');
  await expect(palette(page).getByRole('option', { name: 'নতুন শিক্ষার্থী ভর্তি' })).toHaveCount(0);
  await box(page).fill('কর্মী');
  await expect(palette(page).getByRole('option', { name: 'কর্মী ও শিক্ষক' })).toHaveCount(0);
  await box(page).fill('হাজিরা নিন');
  await expect(palette(page).getByRole('option', { name: 'হাজিরা নিন' })).toBeVisible();
});

import type { StaffMember } from '@jantrik/shared';
import { expect, test } from '@playwright/test';
import { DEMO, api, apiLogin, passwordLogin } from './helpers';

// A class teacher who also collects fees: one action on the staff page (step 9, A5).
test('the owner lets a teacher collect fees in one step; the teacher then sees the counter', async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow();
  const ownerToken = await apiLogin(DEMO.shaplaOwner);
  const staff = await api<StaffMember[]>(ownerToken, '/staff');
  const teacher = staff.find((m) => m.phone === '+8801911000999')!;
  expect(teacher.roles).toEqual(['TEACHER']);

  try {
    await passwordLogin(page, DEMO.shaplaOwner);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto('/staff');
    const row = page.locator(`[data-testid="staff-card"][data-user-id="${teacher.userId}"]`);
    await row.getByRole('button').first().click();
    await page.getByTestId('staff-fee-collection').click();
    await page.getByTestId('staff-fee-collection-confirm').click();
    await expect
      .poll(async () =>
        (await api<StaffMember[]>(ownerToken, '/staff'))
          .find((m) => m.userId === teacher.userId)
          ?.roles.sort(),
      )
      .toEqual(['ACCOUNTANT', 'TEACHER']);

    // The teacher (in two institutes) picks Shapla and finds the fee counter.
    const context = await browser.newContext({
      baseURL,
      locale: 'bn-BD',
      timezoneId: 'Asia/Dhaka',
    });
    const teacherPage = await context.newPage();
    await passwordLogin(teacherPage, DEMO.sharedTeacher);
    await teacherPage.getByRole('button', { name: DEMO.shaplaName }).click();
    await expect(teacherPage).toHaveURL(/\/dashboard$/);
    await teacherPage.goto('/fees');
    await expect(teacherPage.getByTestId('fees-search')).toBeVisible();
    await context.close();
  } finally {
    // Later specs expect this teacher without fee access.
    await api(ownerToken, `/staff/${teacher.userId}/roles`, {
      method: 'PUT',
      json: { roles: ['TEACHER'] },
    });
  }
});

import { expect, test } from '@playwright/test';
import { api, apiLogin, DEMO, passwordLogin } from './helpers';
import { findLayoutProblems } from './layout-check';

// Sprint 1 P3a: an owner makes an admission cycle with a class, opens it, enters a walk-in
// application with Bangla digits, shortlists it and approves it into a section with a roll; the
// student page then shows the child and the guardian.

test('admission: cycle → walk-in application → shortlist → approve into a student', async ({
  page,
}) => {
  await passwordLogin(page, DEMO.shaplaOwner);
  await expect(page).toHaveURL(/\/dashboard$/);

  // A new cycle (the window is wide, so it takes applications whenever the suite runs).
  await page.goto('/admission');
  await page.getByTestId('new-cycle').click();
  await page.locator('#cycleNameBn').fill('ভর্তি পরীক্ষা ছাড়া (e2e)');
  await page.locator('#opensAt').fill('2026-01-01T00:00');
  await page.locator('#closesAt').fill('2030-12-31T23:00');
  await page.getByTestId('save-cycle').click();
  await expect(page).toHaveURL(/\/admission\/cycles\/[0-9a-f-]{36}$/);

  // One class (class 9), then open the form.
  await page.getByTestId('add-class').click();
  await page.getByTestId('class-row').first().locator('select').first().selectOption({
    label: 'নবম শ্রেণি',
  });
  await page.getByTestId('save-classes').click();
  await expect(page.getByText('সংরক্ষিত হয়েছে').first()).toBeVisible();
  await page.getByTestId('open-cycle').click();
  await expect(page.getByText('এখন আবেদন নেওয়া হচ্ছে')).toBeVisible();
  expect(await findLayoutProblems(page)).toEqual([]);

  // A walk-in application, typed with Bangla digits.
  await page.goto('/admission/applications/new');
  await page.locator('#cycleClassId').selectOption({ index: 1 });
  await page.locator('#nameBn').fill('আরিফ হোসেন');
  await page.locator('#dateOfBirth').fill('০১/০৫/২০১২');
  await page.locator('#gender').selectOption('MALE');
  await page.locator('#birthRegistrationNo').fill('২০১২ ২৬৯২ ৫১২৩ ৯৯৯৯ ১');
  await page.locator('#guardianNameBn').fill('মোশাররফ হোসেন');
  await page.locator('#phone').fill('০১৮১৯৯০০৭৭৭');
  await page.getByTestId('save-application').click();
  await expect(page).toHaveURL(/\/admission\/applications\/[0-9a-f-]{36}$/);
  await expect(page.getByText('অফিসে লেখা')).toBeVisible();
  await expect(page.getByText('20122692512399991')).toBeVisible();
  await expect(page.getByText('01819-900777')).toBeVisible();

  // Shortlist, then approve into a section with roll ৯৭.
  await page.getByTestId('shortlist').click();
  await expect(page.getByText('প্রাথমিক তালিকায়').first()).toBeVisible();
  await page.getByTestId('approve-open').click();
  const dialog = page.getByTestId('approve-dialog');
  await dialog.locator('#approve-section').selectOption({ index: 1 });
  await dialog.locator('#approve-roll').fill('৯৭');
  await dialog.getByRole('button', { name: 'শিক্ষার্থী হিসেবে ভর্তি' }).click();
  await expect(page.getByText('ভর্তি হয়েছে').first()).toBeVisible();

  // The student exists with the guardian.
  await page.getByRole('link', { name: 'শিক্ষার্থী দেখুন' }).click();
  await expect(page.getByTestId('student-profile')).toContainText('আরিফ হোসেন');
  await expect(page.getByTestId('profile-guardians-list')).toContainText('01819-900777');

  const studentId = /\/students\/([0-9a-f-]{36})/.exec(page.url())![1]!;

  // The list finds it by number and shows it admitted.
  await page.goto('/admission/applications');
  await page.locator('#filter-q').fill('আরিফ');
  await expect(page.getByTestId('application-list')).toContainText('ভর্তি হয়েছে');

  // The suite shares one database: other specs count the demo school's students, so the new
  // student is deactivated again (a soft delete, which lists and counts leave out).
  await api(await apiLogin(DEMO.shaplaOwner), `/students/${studentId}/deactivate`, {
    method: 'POST',
  });
});

test('admission: a teacher has no admission menu', async ({ page }) => {
  await passwordLogin(page, DEMO.shaplaTeacher);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('link', { name: 'ভর্তি', exact: true })).toHaveCount(0);
});

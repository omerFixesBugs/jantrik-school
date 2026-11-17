import { expect, test } from '@playwright/test';
import { api, apiLogin, DEMO, passwordLogin, readOtp } from './helpers';

// Sprint 1 P4: an owner sets a class's admission test, issues rolls, shows the admit cards (two
// to an A4 in print), enters scores with Bangla digits (one absent), builds and publishes the
// merit list, sends the result SMS (outbox), and offers a freed seat to the waitlist; the
// applicant then sees the published result on the status page after a code.

interface Cycle {
  id: string;
  classes: { id: string }[];
}
interface Options {
  years: { id: string; isCurrent: boolean }[];
  classLevels: { id: string; nameBn: string }[];
}

test('admission test: setup → rolls → admit cards → scores → merit list → SMS → waitlist → the result', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  // Its own phones and birth registration numbers per run (a retry must not be a duplicate).
  const n = String((Date.now() + testInfo.retry) % 1e6).padStart(6, '0');
  const owner = await apiLogin(DEMO.shaplaOwner);
  const options = await api<Options>(owner, '/admission/options');
  const cycle = await api<Cycle>(owner, '/admission/cycles', {
    method: 'POST',
    json: {
      academicYearId: options.years.find((y) => y.isCurrent)!.id,
      nameBn: 'ভর্তি পরীক্ষা (e2e)',
      opensAt: '2026-01-01T00:00:00+06:00',
      closesAt: '2030-12-31T00:00:00+06:00',
      requiresTest: true,
    },
  });
  const class7 = options.classLevels.find((c) => c.nameBn === 'সপ্তম শ্রেণি')!;
  const withClass = await api<Cycle>(owner, `/admission/cycles/${cycle.id}/classes`, {
    method: 'PUT',
    json: { classes: [{ classLevelId: class7.id }] },
  });
  const cc = withClass.classes[0]!.id;
  await api(owner, `/admission/cycles/${cycle.id}/status`, {
    method: 'POST',
    json: { status: 'OPEN' },
  });
  // Three walk-ins: rolls 1, 2, 3 by application number.
  const applicants = [
    { nameBn: 'প্রথম পরীক্ষার্থী', phone: `01712${n}` },
    { nameBn: 'দ্বিতীয় পরীক্ষার্থী', phone: `01713${n}` },
    { nameBn: 'তৃতীয় পরীক্ষার্থী', phone: `01714${n}` },
  ];
  const apps: { id: string; applicationNo: string }[] = [];
  for (const [i, a] of applicants.entries()) {
    apps.push(
      await api<{ id: string; applicationNo: string }>(owner, '/admission/applications', {
        method: 'POST',
        json: {
          cycleClassId: cc,
          nameBn: a.nameBn,
          dateOfBirth: '2013-05-01',
          gender: 'MALE',
          birthRegistrationNo: `2013269251${i}${n}`,
          guardianNameBn: 'অভিভাবক',
          guardianRelation: 'FATHER',
          phone: a.phone,
        },
      }),
    );
  }

  await passwordLogin(page, DEMO.shaplaOwner);
  await page.goto(`/admission/cycles/${cycle.id}`);
  await page.getByTestId('open-test').first().click();
  await expect(page.getByTestId('admission-test')).toBeVisible();

  // The test: date, time, venue, marks and seats (one selected, one on the waitlist); rolls.
  await page.locator('#testDate').fill('2026-12-20');
  await page.locator('#testTime').fill('10:30');
  await page.locator('#testVenueBn').fill('মূল ভবন');
  await page.locator('#fullMarks').fill('১০০');
  await page.locator('#passMarks').fill('৩৩');
  await page.locator('#selectCount').fill('১');
  await page.locator('#waitlistCount').fill('১');
  await page.getByTestId('save-test').click();
  await expect(page.getByText('সংরক্ষিত').first()).toBeVisible();
  await page.getByTestId('issue-rolls').click();
  await expect(page.getByText('রোল আছে: ৩')).toBeVisible();

  // The admit cards: three, two to a printed A4.
  await page.getByTestId('test-tab-cards').click();
  await page.getByTestId('show-cards').click();
  await expect(page.getByTestId('admission-admit-card')).toHaveCount(3);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.exam-page')).toHaveCount(2);
  await page.emulateMedia({ media: 'screen' });

  // The scores, with Bangla digits; roll 2 absent.
  await page.getByTestId('test-tab-scores').click();
  await page.getByTestId('score-1').fill('৯০');
  await page.getByTestId('absent-2').check();
  await page.getByTestId('score-3').fill('৮৫.৫০');
  await page.getByTestId('save-scores').click();
  await expect(page.getByText('নম্বর সংরক্ষিত').first()).toBeVisible();

  // Build and publish: roll 1 selected, roll 3 waitlisted, roll 2 rejected (absent).
  await page.getByTestId('test-tab-merit').click();
  await page.getByTestId('build-merit').click();
  await expect(page.getByTestId('merit-row')).toHaveCount(3);
  await page.getByTestId('publish-merit').click();
  await expect(page.getByTestId('merit-state')).toContainText('সংস্করণ ১');
  await expect(page.getByTestId('merit-table')).toContainText('অপেক্ষমাণ');

  // The result SMS: three to send.
  await page.getByTestId('test-tab-sms').click();
  await expect(page.getByTestId('sms-preview')).toContainText('৩টি এসএমএস');
  await page.getByTestId('send-result-sms').click();
  await expect(page.getByTestId('sms-run')).toContainText('পাঠানো ৩', { timeout: 20_000 });

  // Roll 1 withdraws; the waitlist moves up: roll 3 is selected.
  await api(owner, `/admission/applications/${apps[0]!.id}/status`, {
    method: 'POST',
    json: { status: 'WITHDRAWN', reason: 'অন্য প্রতিষ্ঠানে ভর্তি' },
  });
  await page.getByTestId('move-up').click();
  await expect(page.getByText(`এখন নির্বাচিত: ${apps[2]!.applicationNo}`)).toBeVisible();

  // The applicant (roll 3) sees the published result after a code.
  await page.goto('/apply/shapla-school/status');
  await page.locator('#status-no').fill(apps[2]!.applicationNo);
  await page.locator('#status-phone').fill(applicants[2]!.phone);
  await page.getByTestId('turnstile-standin').check();
  await page.getByRole('button', { name: 'কোড পাঠান' }).click();
  const code = await readOtp(applicants[2]!.phone);
  await page.locator('#status-code').fill(code);
  await page.getByRole('button', { name: 'অবস্থা দেখুন' }).click();
  await expect(page.getByTestId('status-shown')).toContainText('নির্বাচিত');
  await expect(page.getByTestId('status-result')).toContainText('মেধাক্রম: ২');
  await expect(page.getByTestId('status-result')).toContainText('৮৫.৫');
});

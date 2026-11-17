import { expect, test } from '@playwright/test';
import { api, apiLogin, DEMO, readOtp } from './helpers';

// Sprint 1 P3b: a guardian applies on a phone (390 px, bn) without an account: class, phone in
// Bangla digits, the code from the SMS outbox, the form (birth registration in Bangla digits),
// the slip; then checks the status. The owner approves it and the student appears.

interface Cycle {
  id: string;
  classes: { id: string; classLevel: { nameBn: string } }[];
}
interface Options {
  years: { id: string; isCurrent: boolean }[];
  classLevels: { id: string; nameBn: string }[];
}

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('apply → status → the owner approves → the student appears', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  // A phone of its own per attempt: a phone gets one code a minute and five a day.
  const phone = `0182233445${testInfo.retry}`;
  const phoneBn = phone.replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!);
  const owner = await apiLogin(DEMO.shaplaOwner);
  const options = await api<Options>(owner, '/admission/options');
  const cycle = await api<Cycle>(owner, '/admission/cycles', {
    method: 'POST',
    json: {
      academicYearId: options.years.find((y) => y.isCurrent)!.id,
      nameBn: 'অনলাইন ভর্তি (e2e)',
      opensAt: '2026-01-01T00:00:00+06:00',
      closesAt: '2030-12-31T00:00:00+06:00',
    },
  });
  const class8 = options.classLevels.find((c) => c.nameBn === 'অষ্টম শ্রেণি')!;
  await api(owner, `/admission/cycles/${cycle.id}/classes`, {
    method: 'PUT',
    json: { classes: [{ classLevelId: class8.id }] },
  });
  await api(owner, `/admission/cycles/${cycle.id}/status`, {
    method: 'POST',
    json: { status: 'OPEN' },
  });

  let studentId: string | null = null;
  try {
    // The guardian, signed out.
    await page.goto('/apply/shapla-school');
    await expect(page.getByTestId('apply-class')).toBeVisible();
    await page.getByText('অষ্টম শ্রেণি').first().tap();
    await page.getByRole('button', { name: 'পরের ধাপ' }).tap();

    await page.locator('#apply-phone').fill(phoneBn);
    await page.getByTestId('turnstile-standin').check();
    await page.getByRole('button', { name: 'কোড পাঠান' }).tap();
    const code = await readOtp(phone);
    await page.locator('#apply-code').fill(code);
    await page.getByRole('button', { name: 'এগিয়ে যান' }).tap();

    await expect(page.getByTestId('apply-form')).toBeVisible();
    await page.locator('#nameBn').fill('সাদিয়া ইসলাম');
    await page.locator('#dateOfBirth').fill('১৫/০৩/২০১২');
    await page.locator('#gender').selectOption('FEMALE');
    // Its own birth registration number per attempt too (an earlier attempt's would be a duplicate).
    await page
      .locator('#birthRegistrationNo')
      .fill(`২০১২ ২৬৯২ ৫১২৩ ৭৭৭৭ ${'০১২৩৪৫৬৭৮৯'[testInfo.retry]}`);
    await page.locator('#guardianNameBn').fill('রফিকুল ইসলাম');
    await page.getByTestId('apply-next').tap();
    await expect(page.getByTestId('apply-review')).toContainText(
      `${phone.slice(0, 5)}-${phone.slice(5)}`,
    );
    // The form ticket refuses a submit under 15 s after the form opened (decision P3-L).
    await page.waitForTimeout(15_000);
    await page.getByTestId('turnstile-standin').check();
    await page.getByTestId('apply-submit').tap();
    const slip = page.getByTestId('application-no');
    await expect(slip).toHaveText(/^\d{4}-\d{4,6}$/);
    const applicationNo = (await slip.textContent())!.trim();

    // The status, with a new code to the same phone (the suite's cooldown is 1 s).
    await page.goto('/apply/shapla-school/status');
    await page.locator('#status-no').fill(applicationNo);
    await page.locator('#status-phone').fill(phone);
    await page.getByTestId('turnstile-standin').check();
    await page.getByRole('button', { name: 'কোড পাঠান' }).tap();
    const second = await readOtp(phone, code);
    await page.locator('#status-code').fill(second);
    await page.getByRole('button', { name: 'অবস্থা দেখুন' }).tap();
    await expect(page.getByTestId('status-shown')).toContainText('জমা হয়েছে');

    // The owner approves it; the student appears.
    const list = await api<{ items: { id: string; applicationNo: string }[] }>(
      owner,
      `/admission/applications?q=${encodeURIComponent(applicationNo)}`,
    );
    const application = list.items.find((i) => i.applicationNo === applicationNo)!;
    const approved = await api<{ studentId: string }>(
      owner,
      `/admission/applications/${application.id}/approve`,
      { method: 'POST', json: {} },
    );
    studentId = approved.studentId;
    const student = await api<{ nameBn: string; enrolments: { classLevel: { nameBn: string } }[] }>(
      owner,
      `/students/${approved.studentId}`,
    );
    expect(student.nameBn).toBe('সাদিয়া ইসলাম');
    expect(student.enrolments[0]?.classLevel.nameBn).toBe('অষ্টম শ্রেণি');
  } finally {
    // The suite shares one database: the specs after this one count the demo school's students,
    // so the student made here is deactivated again, also when a step above failed.
    if (studentId) await api(owner, `/students/${studentId}/deactivate`, { method: 'POST' });
  }
});

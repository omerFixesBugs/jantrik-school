import { readFile } from 'node:fs/promises';
import {
  toBanglaDigits,
  type ExamDetail,
  type ExamListItem,
  type GuardianChild,
  type SetupSection,
} from '@jantrik/shared';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { findLayoutProblems } from './layout-check';
import {
  api,
  API_URL,
  apiLogin,
  apiOtpLogin,
  DEMO,
  otpLoginWithBanglaDigits,
  passwordLogin,
} from './helpers';

// Step 10: a subject teacher enters the annual exam's marks on a phone, the office locks and
// publishes, the tabulation and report cards print, a guardian sees the report card, and the
// result SMS goes out. The seed leaves two annual sheets empty for this: 6 ক Bangla (bn, Nasrin)
// and 9 ক English (en, Sharmin); every other sheet is locked.

const PHONE = { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true };
const GUARDIAN_PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const DESK = { viewport: { width: 1366, height: 900 } };

const CASES = [
  {
    lang: 'bn',
    teacher: DEMO.shaplaTeacher,
    twoInstitutes: false,
    classCode: 'CLASS_6',
    subjectCode: 'BAN',
    otherSubjectCode: 'ENG',
    // Tasnim's mother: Tasnim is in 6 ক; her brother Tahmid is not her child in the records.
    guardian: DEMO.shaplaGuardian2,
    child: 'SHS-2026-0001',
  },
  {
    lang: 'en',
    teacher: DEMO.sharedTeacher,
    twoInstitutes: true,
    classCode: 'CLASS_9',
    subjectCode: 'ENG',
    otherSubjectCode: null,
    // Tahmid (9 ক, Higher Maths as his 4th subject): his father's account.
    guardian: DEMO.shaplaGuardian,
    child: 'SHS-2026-0002',
  },
] as const;

type Lang = (typeof CASES)[number]['lang'];

const digits = (n: number, lang: Lang) => (lang === 'bn' ? toBanglaDigits(String(n)) : String(n));

async function useLanguage(page: Page, lang: Lang) {
  await page.context().addCookies([{ name: 'NEXT_LOCALE', value: lang, url: page.url() }]);
  await page.reload();
}

async function newPage(browser: Browser, baseURL: string | undefined, device: object) {
  const context = await browser.newContext({
    ...device,
    baseURL,
    locale: 'bn-BD',
    timezoneId: 'Asia/Dhaka',
    acceptDownloads: true,
  });
  return context.newPage();
}

/** The open annual exam and the ids a case needs (read as the owner, through the API). */
async function annualFor(classCode: string, subjectCode: string, otherCode: string | null) {
  const owner = await apiLogin(DEMO.shaplaOwner);
  const exams = await api<ExamListItem[]>(owner, '/exams');
  const annual = exams.find((e) => e.kind === 'ANNUAL')!;
  const half = exams.find((e) => e.kind === 'HALF_YEARLY')!;
  const detail = await api<ExamDetail>(owner, `/exams/${annual.id}`);
  const halfDetail = await api<ExamDetail>(owner, `/exams/${half.id}`);
  const examClass = detail.classes.find((c) => c.classLevel.code === classCode)!;
  const sections = await api<SetupSection[]>(
    owner,
    `/setup/sections?academicYearId=${annual.academicYearId}`,
  );
  const section = sections.find(
    (s) => s.classLevelId === examClass.classLevel.id && s.name === 'ক',
  )!;
  const subjectId = (code: string) => examClass.subjects.find((s) => s.subject.code === code)!.id;
  return {
    annualId: annual.id,
    examClassId: examClass.id,
    sectionId: section.id,
    subjectId: subjectId(subjectCode),
    otherSubjectId: otherCode ? subjectId(otherCode) : null,
    halfClass9: halfDetail.classes.find((c) => c.classLevel.code === 'CLASS_9')!.id,
  };
}

for (const c of CASES) {
  test(`${c.lang}: a teacher enters marks on a phone, the office publishes, a guardian sees the report card`, async ({
    browser,
    baseURL,
  }) => {
    test.slow();
    test.setTimeout(240_000);
    const ids = await annualFor(c.classCode, c.subjectCode, c.otherSubjectCode);

    // Before publishing, the annual exam is nowhere in a guardian's results (checked once).
    let children: GuardianChild[] = [];
    if (c.lang === 'bn') {
      const father = await apiOtpLogin(DEMO.shaplaGuardian);
      children = await api<GuardianChild[]>(father, '/me/children');
      for (const child of children) {
        const results = await api<{ exam: { kind: string } }[]>(
          father,
          `/me/children/${child.id}/results`,
        );
        expect(results.map((r) => r.exam.kind)).not.toContain('ANNUAL');
        expect(results.map((r) => r.exam.kind)).toContain('HALF_YEARLY');
      }
    }

    // ── The subject teacher, 360 px ──
    const teacher = await newPage(browser, baseURL, PHONE);
    await passwordLogin(teacher, c.teacher);
    if (c.twoInstitutes) await teacher.getByRole('button', { name: DEMO.shaplaName }).click();
    await expect(teacher).toHaveURL(/\/dashboard$/);
    await useLanguage(teacher, c.lang);
    await teacher.goto('/exams');
    await teacher
      .locator(`a[data-testid="my-sheet"][href*="subject=${ids.subjectId}"]`)
      .first()
      .click();
    const rows = teacher.getByTestId('sheet-row');
    await expect(rows.first()).toBeVisible();
    expect(await findLayoutProblems(teacher)).toEqual([]);
    const count = await rows.count();
    // 9 ক has two students, 6 ক twenty-seven.
    expect(count).toBeGreaterThan(1);
    const cell = (i: number) => rows.nth(i).locator('[data-testid^="mark-input-"]').first();
    const parts = teacher.getByTestId('sheet-parts').getByRole('radio');
    const partCount = (await parts.count()) || 1;
    const value = (i: number) => digits(20 + (i % 9), c.lang);

    // Enter moves down the list; Bangla digits are accepted.
    await cell(0).fill(value(0));
    await cell(0).press('Enter');
    await expect(cell(1)).toBeFocused();
    // Over the full marks: refused inline, then corrected.
    await cell(1).fill(digits(150, c.lang));
    await expect(rows.nth(1).getByRole('alert')).toBeVisible();
    await cell(1).fill(value(1));
    await expect(rows.nth(1).getByRole('alert')).toHaveCount(0);
    // The last student absent in every part.
    const absent = rows.nth(count - 1).getByTestId('mark-absent');
    await absent.click();
    await expect(absent).toHaveAttribute('aria-pressed', 'true');
    for (let i = 2; i < Math.min(count - 1, Math.ceil(count / 2)); i++)
      await cell(i).fill(value(i));

    // A reload mid-way keeps what was typed.
    await teacher.reload();
    await expect(cell(0)).toHaveValue(value(0));
    await expect(teacher.getByTestId('sync-state')).toBeVisible();

    // Offline: kept on this phone, sent once the connection is back.
    const sheets = '**/exams/sheets';
    await teacher.route(sheets, (r) =>
      r.request().method() === 'PUT' ? r.abort('internetdisconnected') : r.fallback(),
    );
    await cell(0).fill(value(5));
    await expect(teacher.getByTestId('sync-state')).toHaveAttribute('data-sync', 'retrying', {
      timeout: 15_000,
    });
    await teacher.unroute(sheets);
    await teacher.getByTestId('sync-state').locator('..').getByRole('button').click();
    await expect(teacher.getByTestId('sync-state')).toHaveAttribute('data-sync', 'saved', {
      timeout: 15_000,
    });

    // Every other cell, part by part, then submit.
    for (let p = 0; p < partCount; p++) {
      if (partCount > 1) await parts.nth(p).click();
      for (let i = 0; i < count; i++) {
        if ((await cell(i).inputValue()) === '') await cell(i).fill(value(i + p));
      }
    }
    await expect(teacher.getByTestId('sheet-progress')).toContainText(digits(count, c.lang));
    await teacher.getByTestId('sheet-submit').click();
    await teacher.getByTestId('sheet-submit-confirm').click();
    await expect(teacher.getByTestId('sync-state')).toHaveAttribute('data-sync', 'saved', {
      timeout: 15_000,
    });
    await expect(teacher.getByTestId('mark-entry')).toContainText(
      c.lang === 'bn' ? 'জমা হয়েছে' : 'Submitted',
    );

    // A subject not assigned to this teacher: refused.
    if (ids.otherSubjectId) {
      await teacher.goto(
        `/exams/${ids.annualId}/sheet?subject=${ids.otherSubjectId}&section=${ids.sectionId}`,
      );
      await expect(teacher.getByTestId('sheet-unavailable')).toContainText(
        'এই বিষয় ও শাখার নম্বর দেওয়ার দায়িত্ব আপনার নয়',
      );
    }
    await teacher.context().close();

    // ── The office, 1366 px: lock, publish, print ──
    const admin = await newPage(browser, baseURL, DESK);
    await passwordLogin(admin, DEMO.shaplaOwner);
    await expect(admin).toHaveURL(/\/dashboard$/);
    await useLanguage(admin, c.lang);
    await admin.goto(`/exams/${ids.annualId}`);
    await admin.getByTestId(`lock-all-${c.classCode}`).click();
    await expect(admin.getByTestId(`lock-all-${c.classCode}`)).toBeDisabled();

    await admin.goto(`/exams/${ids.annualId}?tab=results`);
    await expect(admin.getByTestId(`blockers-${c.classCode}`)).toHaveCount(0);
    await admin.getByTestId(`publish-${c.classCode}`).click();
    await admin.getByTestId('publish-confirm').click();
    await expect(admin.getByTestId(`publish-${c.classCode}`)).toContainText(
      c.lang === 'bn' ? 'আবার প্রকাশ' : 'Publish again',
    );

    // The tabulation sheet: one A4 landscape page per screenful; the CSV has a BOM and ASCII digits.
    await admin.getByTestId(`tabulation-${c.classCode}`).click();
    await expect(admin.getByTestId('tabulation-row').first()).toBeVisible();
    await expect(admin.getByTestId('tabulation-source')).toContainText(
      c.lang === 'bn' ? 'প্রকাশিত' : 'Published',
    );
    const download = admin.waitForEvent('download');
    await admin.getByTestId('tabulation-csv').click();
    const csv = await readFile((await (await download).path())!, 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).not.toMatch(/[০-৯]/);
    expect(csv.split('\n').length).toBeGreaterThan(3);
    await admin.emulateMedia({ media: 'print' });
    const tabulationPdf = (await admin.pdf({ preferCSSPageSize: true })).toString('latin1');
    // A4 landscape: 842 × 595 pt.
    expect(tabulationPdf).toMatch(
      /\/MediaBox\s*\[\s*0\s+0\s+(841|842)(\.\d+)?\s+(594|595)(\.\d+)?\s*\]/,
    );
    await admin.emulateMedia({ media: 'screen' });

    // Report cards of the section: one A4 portrait page each.
    await admin.goto(`/exams/${ids.annualId}?tab=results`);
    await admin.getByTestId(`report-cards-${c.classCode}-ক`).click();
    const cards = admin.getByTestId('report-card');
    await expect(cards.first()).toBeVisible();
    const cardCount = await cards.count();
    await admin.emulateMedia({ media: 'print' });
    await expect(admin.getByTestId('print')).toBeHidden();
    const cardsPdf = (await admin.pdf({ preferCSSPageSize: true })).toString('latin1');
    expect(cardsPdf.match(/\/Type\s*\/Page[^s]/g)?.length).toBe(cardCount);
    expect(cardsPdf).toMatch(
      /\/MediaBox\s*\[\s*0\s+0\s+(594|595)(\.\d+)?\s+(841|842)(\.\d+)?\s*\]/,
    );
    await admin.emulateMedia({ media: 'screen' });

    // ── The guardian, 390 px ──
    const guardian = await newPage(browser, baseURL, GUARDIAN_PHONE);
    await otpLoginWithBanglaDigits(guardian, c.guardian);
    await expect(guardian).toHaveURL(/\/dashboard$/);
    await useLanguage(guardian, c.lang);
    const card = guardian.getByTestId('children').locator('li').filter({ hasText: c.child });
    await expect(card.getByTestId('child-results-headline')).toBeVisible();
    expect(await findLayoutProblems(guardian)).toEqual([]);
    await card.getByTestId('child-results-open').click();
    await expect(guardian.getByTestId('child-result').first()).toContainText(
      c.lang === 'bn' ? 'বার্ষিক পরীক্ষা ২০২৬' : 'Annual exam 2026',
    );
    await guardian.getByTestId('child-result').first().click();
    const reportCard = guardian.getByTestId('report-card');
    await expect(reportCard).toBeVisible();
    await expect(reportCard.getByTestId('report-card-summary')).toBeVisible();
    if (c.lang === 'en') await expect(reportCard).toContainText('(4th subject)');
    expect(await findLayoutProblems(guardian)).toEqual([]);
    await guardian.emulateMedia({ media: 'print' });
    const pdf = (await guardian.pdf({ preferCSSPageSize: true })).toString('latin1');
    expect(pdf.match(/\/Type\s*\/Page[^s]/g)?.length).toBe(1);
    expect(pdf).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+(594|595)(\.\d+)?\s+(841|842)(\.\d+)?\s*\]/);
    await guardian.emulateMedia({ media: 'screen' });
    const [, childId, examClassId] = /\/children\/([^/]+)\/results\/([^/?]+)/.exec(guardian.url())!;
    expect(examClassId).toBe(ids.examClassId);

    // Someone else's child: not found, never the card.
    if (c.lang === 'bn') {
      const tahmid = children.find((x) => x.studentCode === 'SHS-2026-0002')!;
      await guardian.goto(`/children/${tahmid.id}/results/${ids.halfClass9}`);
      await expect(guardian.getByTestId('child-results-not-found')).toBeVisible();
    } else {
      const mother = await apiOtpLogin(DEMO.shaplaGuardian2);
      const res = await fetch(`${API_URL}/me/children/${childId}/results/${examClassId}`, {
        headers: { Authorization: `Bearer ${mother}` },
      });
      expect(res.status).toBe(404);
    }
    await guardian.context().close();

    // ── The office sends the result SMS: preview with the cost, then confirm ──
    await admin.goto(`/exams/${ids.annualId}?tab=results`);
    await admin.getByTestId(`sms-${c.classCode}`).click();
    await expect(admin.getByTestId('sms-preview')).toBeVisible();
    await expect(admin.getByTestId('sms-cost')).not.toBeEmpty();
    await admin.getByTestId('sms-confirm').click();
    await expect(admin.getByTestId('sms-dialog')).toHaveCount(0);
    await admin.context().close();
  });
}

import { addMonths, normalizeBdPhone, todayIn } from '@jantrik/shared';
import type { TenantTx } from '../tenancy/context.js';

const date = (iso: string) => new Date(`${iso}T00:00:00Z`);
const taka = (amount: number) => amount * 100;

/**
 * A fee setup for a demo school (step 9): heads with fine rules, amounts per class (a study
 * group override), terms, the sibling rule, one half free studentship and the institute's
 * bKash/Nagad numbers. Dues start two months before the seed date (within the demo year), so
 * the counter has overdue months to collect. Dues themselves are generated when first viewed
 * (or by the nightly run), as in production. Siblings sharing a guardian phone are left
 * unconfirmed: the admin sees them as a suggestion.
 */
export async function seedDemoFees(tx: TenantTx, tenantId: string, ownerId: string): Promise<void> {
  const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
  const yearStart = year.startDate.toISOString().slice(0, 10);
  const yearEnd = year.endDate.toISOString().slice(0, 10);
  const twoMonthsAgo = `${addMonths(todayIn('Asia/Dhaka').slice(0, 7), -2)}-01`;
  const duesFrom =
    twoMonthsAgo < yearStart
      ? yearStart
      : twoMonthsAgo > yearEnd
        ? `${yearEnd.slice(0, 7)}-01`
        : twoMonthsAgo;

  await tx.feeSettings.create({
    data: {
      tenantId,
      duesFrom: date(duesFrom),
      receiptSmsEnabled: true,
      siblingDiscountType: 'PERCENT',
      siblingDiscountValue: 50,
      siblingFromChild: 2,
      receiptNote: 'ধন্যবাদ। রসিদটি সংরক্ষণ করুন।',
    },
  });

  const head = (data: {
    nameBn: string;
    nameEn: string;
    kind: 'ADMISSION' | 'TUITION' | 'EXAM' | 'SESSION';
    frequency: 'ONE_TIME' | 'MONTHLY' | 'PER_TERM' | 'YEARLY';
    sortOrder: number;
    dueDay?: number;
    dueOffsetDays?: number;
    oneTimeFrom?: Date;
    fineType?: 'FLAT' | 'PER_DAY';
    fineAmountPaisa?: number;
    fineCapPaisa?: number;
    siblingEligible?: boolean;
  }) => tx.feeHead.create({ data: { tenantId, ...data } });
  const admission = await head({
    nameBn: 'ভর্তি ফি',
    nameEn: 'Admission fee',
    kind: 'ADMISSION',
    frequency: 'ONE_TIME',
    dueOffsetDays: 7,
    oneTimeFrom: date(duesFrom),
    sortOrder: 0,
  });
  const tuition = await head({
    nameBn: 'মাসিক বেতন',
    nameEn: 'Monthly tuition',
    kind: 'TUITION',
    frequency: 'MONTHLY',
    dueDay: 10,
    fineType: 'PER_DAY',
    fineAmountPaisa: taka(10),
    fineCapPaisa: taka(100),
    siblingEligible: true,
    sortOrder: 1,
  });
  const exam = await head({
    nameBn: 'পরীক্ষার ফি',
    nameEn: 'Exam fee',
    kind: 'EXAM',
    frequency: 'PER_TERM',
    fineType: 'FLAT',
    fineAmountPaisa: taka(50),
    sortOrder: 2,
  });
  const session = await head({
    nameBn: 'সেশন ফি',
    nameEn: 'Session fee',
    kind: 'SESSION',
    frequency: 'YEARLY',
    dueOffsetDays: 30,
    sortOrder: 3,
  });

  const y = yearStart.slice(0, 4);
  await tx.feeTerm.createMany({
    data: [
      {
        tenantId,
        academicYearId: year.id,
        nameBn: 'অর্ধবার্ষিক পরীক্ষা',
        nameEn: 'Half-yearly exam',
        opensOn: date(`${y}-05-01`),
        dueDate: date(`${y}-05-15`),
        sortOrder: 0,
      },
      {
        tenantId,
        academicYearId: year.id,
        nameBn: 'বার্ষিক পরীক্ষা',
        nameEn: 'Annual exam',
        opensOn: date(`${y}-11-01`),
        dueDate: date(`${y}-11-15`),
        sortOrder: 1,
      },
    ],
  });

  const classes = new Map((await tx.classLevel.findMany()).map((c) => [c.code, c.id]));
  const science = await tx.studyGroup.findFirstOrThrow({ where: { code: 'SCIENCE' } });
  const amount = (
    classCode: string,
    headId: string,
    tk: number,
    studyGroupId: string | null = null,
  ) => ({
    tenantId,
    academicYearId: year.id,
    feeHeadId: headId,
    classLevelId: classes.get(classCode)!,
    studyGroupId,
    amountPaisa: taka(tk),
  });
  await tx.feeAmount.createMany({
    data: [
      amount('CLASS_6', admission.id, 3000),
      amount('CLASS_6', tuition.id, 800),
      amount('CLASS_6', exam.id, 500),
      amount('CLASS_6', session.id, 2000),
      amount('CLASS_9', admission.id, 3500),
      amount('CLASS_9', tuition.id, 1000),
      amount('CLASS_9', tuition.id, 1200, science.id),
      amount('CLASS_9', exam.id, 600),
      amount('CLASS_9', session.id, 2500),
    ],
  });

  // Half free studentship for Arpita (Class 6 খ), on tuition.
  const arpita = await tx.student.findFirstOrThrow({ where: { studentCode: 'SHS-2026-0003' } });
  await tx.feeConcession.create({
    data: {
      tenantId,
      studentId: arpita.id,
      feeHeadId: tuition.id,
      academicYearId: year.id,
      category: 'FREE_HALF',
      type: 'PERCENT',
      value: 50,
      reason: 'আর্থিক অসচ্ছলতা',
      validFrom: date(yearStart),
      createdById: ownerId,
    },
  });

  await tx.feeMobileAccount.createMany({
    data: [
      {
        tenantId,
        method: 'BKASH',
        phone: normalizeBdPhone('01711000901')!,
        kind: 'PERSONAL',
        label: 'অফিস',
        sortOrder: 0,
      },
      {
        tenantId,
        method: 'NAGAD',
        phone: normalizeBdPhone('01711000902')!,
        kind: 'MERCHANT',
        sortOrder: 1,
      },
    ],
  });
}

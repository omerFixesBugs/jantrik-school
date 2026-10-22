/**
 * Fee rules (module FEES, docs/fees.md): pure functions shared by the API, the web app, the seed
 * and the tests, so a fine, an allocation or a due is computed the same way everywhere.
 * Money is integer paisa; dates are `YYYY-MM-DD` calendar dates in the tenant's timezone.
 */
import { addDays, type IsoDate } from './dates.js';
import { toAsciiDigits } from './digits.js';
import type { UiLocale } from './format.js';

export const FEE_HEAD_KINDS = ['ADMISSION', 'TUITION', 'EXAM', 'SESSION', 'OTHER'] as const;
export type FeeHeadKind = (typeof FEE_HEAD_KINDS)[number];
export const FEE_FREQUENCIES = ['ONE_TIME', 'MONTHLY', 'PER_TERM', 'YEARLY'] as const;
export type FeeFrequency = (typeof FEE_FREQUENCIES)[number];
export const FEE_FINE_TYPES = ['NONE', 'FLAT', 'PER_DAY'] as const;
export type FeeFineType = (typeof FEE_FINE_TYPES)[number];
export const FEE_AMOUNT_TYPES = ['FIXED', 'PERCENT'] as const;
export type FeeAmountType = (typeof FEE_AMOUNT_TYPES)[number];
export const FEE_CONCESSION_CATEGORIES = [
  'GENERAL',
  'FREE_FULL',
  'FREE_HALF',
  'SCHOLARSHIP',
] as const;
export type FeeConcessionCategory = (typeof FEE_CONCESSION_CATEGORIES)[number];
export type ConcessionSource = 'NONE' | 'MANUAL' | 'SIBLING';

/** The largest single fee amount (৳10 lakh), as the database CHECKs allow. */
export const MAX_FEE_PAISA = 100_000_000;
/** A student admitted inside a period gets at least this many days to pay its due. */
export const LATE_JOINER_GRACE_DAYS = 7;

// ───────────────────────────── Money input ─────────────────────────────

const TAKA_INPUT = /^\d+(\.\d{1,2})?$/;

/**
 * What someone typed ("১,২৫০.৫০", "1250", "10,00,000") → paisa, or null when it is not an
 * amount (negative, more than 2 decimals, letters, above ৳10 lakh). Bangla digits accepted.
 */
export function parseTaka(input: string): number | null {
  const text = toAsciiDigits(input).trim().replaceAll(',', '');
  if (!TAKA_INPUT.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const paisa = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(paisa) && paisa <= MAX_FEE_PAISA ? paisa : null;
}

// ───────────────────────────── Fines and balances ─────────────────────────────

export interface FineRule {
  type: FeeFineType;
  amountPaisa: number;
  capPaisa: number | null;
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The late fine a due has accrued by `asOf`: nothing on or before the due date; FLAT: the amount
 * from the next day; PER_DAY: days late × the amount, never above the cap.
 */
export function fineAccrued(rule: FineRule, dueDate: IsoDate, asOf: IsoDate): number {
  const days = daysBetween(dueDate, asOf);
  if (days <= 0) return 0;
  switch (rule.type) {
    case 'NONE':
      return 0;
    case 'FLAT':
      return rule.amountPaisa;
    case 'PER_DAY':
      return Math.min(days * rule.amountPaisa, rule.capPaisa ?? Number.MAX_SAFE_INTEGER);
  }
}

export interface DueBalanceInput {
  status: 'OPEN' | 'CANCELLED';
  amountPaisa: number;
  concessionPaisa: number;
  paidPrincipalPaisa: number;
  paidFinePaisa: number;
  /** The date the principal was fully paid (the fine stops growing then). */
  principalClearedOn: IsoDate | null;
  dueDate: IsoDate;
  fine: FineRule;
  fineWaivedPaisa: number;
  fineWaivedAll: boolean;
}

export interface DueBalance {
  principal: number;
  fine: number;
  total: number;
}

/** What is still owed on one due today: the principal and the fine (accrued − paid − waived). */
export function dueBalance(due: DueBalanceInput, today: IsoDate): DueBalance {
  if (due.status === 'CANCELLED') return { principal: 0, fine: 0, total: 0 };
  const net = due.amountPaisa - due.concessionPaisa;
  const principal = Math.max(0, net - due.paidPrincipalPaisa);
  const accrued = net > 0 ? fineAccrued(due.fine, due.dueDate, due.principalClearedOn ?? today) : 0;
  const fine = due.fineWaivedAll
    ? 0
    : Math.max(0, accrued - due.paidFinePaisa - due.fineWaivedPaisa);
  return { principal, fine, total: principal + fine };
}

// ───────────────────────────── Allocation ─────────────────────────────

export interface AllocatableDue {
  id: string;
  dueDate: IsoDate;
  /** Tie-break between dues on the same date (the head's sort order). */
  sortOrder?: number;
  principal: number;
  fine: number;
}

export interface Allocation {
  dueId: string;
  principalPaisa: number;
  finePaisa: number;
}

/**
 * Where a payment goes among the dues the payer chose: principal first, oldest due first, then
 * fines, oldest first (so fines stop growing as early as possible). The amount must be whole
 * paisa, above zero and at most what the chosen dues owe: there are no credit balances.
 */
export function allocate(dues: readonly AllocatableDue[], amountPaisa: number): Allocation[] {
  const owed = dues.reduce((sum, d) => sum + d.principal + d.fine, 0);
  if (!Number.isInteger(amountPaisa) || amountPaisa <= 0 || amountPaisa > owed) {
    throw new RangeError(`Cannot allocate ${amountPaisa} paisa to dues owing ${owed}`);
  }
  const ordered = [...dues].sort(
    (a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const result = new Map(
    ordered.map((d) => [d.id, { dueId: d.id, principalPaisa: 0, finePaisa: 0 }]),
  );
  let left = amountPaisa;
  for (const part of ['principal', 'fine'] as const) {
    for (const due of ordered) {
      const take = Math.min(left, due[part]);
      if (take <= 0) continue;
      const row = result.get(due.id)!;
      if (part === 'principal') row.principalPaisa += take;
      else row.finePaisa += take;
      left -= take;
    }
  }
  return [...result.values()].filter((r) => r.principalPaisa + r.finePaisa > 0);
}

// ───────────────────────────── Concessions and siblings ─────────────────────────────

export interface ConcessionRule {
  type: FeeAmountType;
  /** Paisa (FIXED) or whole percent 1–100 (PERCENT). */
  value: number;
}

/** A concession's paisa on an amount: FIXED up to the amount; PERCENT rounded half up. */
export function concessionAmount(amountPaisa: number, rule: ConcessionRule): number {
  if (rule.type === 'FIXED') return Math.min(rule.value, amountPaisa);
  return Math.min(amountPaisa, Math.floor((amountPaisa * rule.value + 50) / 100));
}

/** Concessions never stack: the larger of the manual one and the sibling discount (tie: manual). */
export function effectiveConcession(
  amountPaisa: number,
  manual: ConcessionRule | null,
  sibling: ConcessionRule | null,
): { paisa: number; source: ConcessionSource } {
  const m = manual ? concessionAmount(amountPaisa, manual) : 0;
  const s = sibling ? concessionAmount(amountPaisa, sibling) : 0;
  if (m === 0 && s === 0) return { paisa: 0, source: 'NONE' };
  return m >= s ? { paisa: m, source: 'MANUAL' } : { paisa: s, source: 'SIBLING' };
}

export interface SiblingMember {
  studentId: string;
  /** The class level's sort order: higher = higher class. */
  classSortOrder: number;
  /** When the student was admitted (students.created_at). */
  admittedAt: string | Date;
}

/**
 * Ranks inside one confirmed family: 1 = the student in the highest class (pays full), ties go
 * to the earlier admission. The sibling discount applies from rank `from_child` (default 2).
 */
export function siblingRanks(members: readonly SiblingMember[]): Map<string, number> {
  const sorted = [...members].sort(
    (a, b) =>
      b.classSortOrder - a.classSortOrder ||
      new Date(a.admittedAt).getTime() - new Date(b.admittedAt).getTime() ||
      a.studentId.localeCompare(b.studentId),
  );
  return new Map(sorted.map((m, i) => [m.studentId, i + 1]));
}

// ───────────────────────────── Periods and the dues plan ─────────────────────────────

export interface FeePeriod {
  /** 'YYYY-MM' (monthly), 'T:<termId>' (per term), 'Y' (yearly), 'ONCE' (one-time). */
  key: string;
  periodStart: IsoDate;
  /** Last day the period covers; a student admitted after it is not charged for it. */
  periodEnd: IsoDate;
  dueDate: IsoDate;
  termId: string | null;
}

export interface PeriodHead {
  frequency: FeeFrequency;
  dueDay: number | null;
  dueOffsetDays: number;
}

export interface PeriodYear {
  startDate: IsoDate;
  endDate: IsoDate;
}

export interface PeriodTerm {
  id: string;
  opensOn: IsoDate;
  dueDate: IsoDate;
}

const maxDate = (a: IsoDate, b: IsoDate) => (a > b ? a : b);
const minDate = (a: IsoDate, b: IsoDate) => (a < b ? a : b);
const pad2 = (n: number) => String(n).padStart(2, '0');

function lastDayOfMonth(year: number, month: number): IsoDate {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate(); // month is 1-based here
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** The periods of a recurring head in an academic year (none for ONE_TIME: see the plan). */
export function feePeriods(
  head: PeriodHead,
  year: PeriodYear,
  terms: readonly PeriodTerm[],
): FeePeriod[] {
  switch (head.frequency) {
    case 'ONE_TIME':
      return [];
    case 'YEARLY':
      return [
        {
          key: 'Y',
          periodStart: year.startDate,
          periodEnd: year.endDate,
          dueDate: addDays(year.startDate, head.dueOffsetDays),
          termId: null,
        },
      ];
    case 'PER_TERM':
      return [...terms]
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        .map((t) => ({
          key: `T:${t.id}`,
          periodStart: t.opensOn,
          periodEnd: t.dueDate,
          dueDate: t.dueDate,
          termId: t.id,
        }));
    case 'MONTHLY': {
      const periods: FeePeriod[] = [];
      let y = Number(year.startDate.slice(0, 4));
      let m = Number(year.startDate.slice(5, 7));
      const endKey = year.endDate.slice(0, 7);
      for (;;) {
        const key = `${y}-${pad2(m)}`;
        if (key > endKey) break;
        const periodStart = maxDate(`${key}-01`, year.startDate);
        periods.push({
          key,
          periodStart,
          periodEnd: minDate(lastDayOfMonth(y, m), year.endDate),
          dueDate: maxDate(`${key}-${pad2(head.dueDay ?? 1)}`, periodStart),
          termId: null,
        });
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
      }
      return periods;
    }
  }
}

export interface PlanHead extends PeriodHead {
  id: string;
  oneTimeFrom: IsoDate | null;
  siblingEligible: boolean;
  isActive: boolean;
  fine: FineRule;
}

export interface PlanAmount {
  feeHeadId: string;
  classLevelId: string;
  studyGroupId: string | null;
  amountPaisa: number;
}

export interface PlanConcession extends ConcessionRule {
  id: string;
  feeHeadId: string;
  validFrom: IsoDate;
  endedOn: IsoDate | null;
}

export interface PlanInput {
  /** Today in the tenant's timezone. */
  asOf: IsoDate;
  /** Paying ahead: also plan periods starting up to this date (null = only started ones). */
  upTo: IsoDate | null;
  /** fee_settings.dues_from; null = no dues at all yet. */
  duesFrom: IsoDate | null;
  /** The sibling rule (null = none). */
  sibling: (ConcessionRule & { fromChild: number }) | null;
  year: { id: string } & PeriodYear;
  heads: readonly PlanHead[];
  terms: readonly PeriodTerm[];
  amounts: readonly PlanAmount[];
  student: {
    id: string;
    /** Admission date in the tenant's timezone (students.created_at). */
    admittedOn: IsoDate;
    classLevelId: string;
    studyGroupId: string | null;
    /** Rank in a confirmed family (siblingRanks), null when not in one. */
    siblingRank: number | null;
  };
  /** The student's manual concessions for this year (active or ended). */
  concessions: readonly PlanConcession[];
}

export interface PlannedDue {
  feeHeadId: string;
  periodKey: string;
  periodStart: IsoDate;
  dueDate: IsoDate;
  termId: string | null;
  amountPaisa: number;
  concessionPaisa: number;
  concessionSource: ConcessionSource;
  concessionId: string | null;
  fine: FineRule;
}

function amountFor(input: PlanInput, headId: string): number | null {
  const { classLevelId, studyGroupId } = input.student;
  const match = (group: string | null) =>
    input.amounts.find(
      (a) => a.feeHeadId === headId && a.classLevelId === classLevelId && a.studyGroupId === group,
    );
  return ((studyGroupId ? match(studyGroupId) : undefined) ?? match(null))?.amountPaisa ?? null;
}

/**
 * The dues one student should have in the current year, as of today (or up to a later date when
 * paying ahead). Idempotent by design: the caller inserts them with ON CONFLICT DO NOTHING on
 * (student, head, year, period). A due exists when the period has started (or is paid ahead),
 * starts on or after `dues_from`, has not ended before the student was admitted, and the
 * student's class (or study group) has an amount for an active head.
 */
export function planStudentDues(input: PlanInput): PlannedDue[] {
  if (!input.duesFrom) return [];
  const duesFrom = input.duesFrom;
  const limit = input.upTo ? maxDate(input.asOf, input.upTo) : input.asOf;
  const { student } = input;
  const planned: PlannedDue[] = [];

  for (const head of input.heads) {
    if (!head.isActive) continue;
    const amount = amountFor(input, head.id);
    if (!amount) continue;

    let periods: FeePeriod[];
    if (head.frequency === 'ONE_TIME') {
      const eligible =
        head.oneTimeFrom !== null &&
        student.admittedOn >= head.oneTimeFrom &&
        student.admittedOn >= duesFrom;
      periods = eligible
        ? [
            {
              key: 'ONCE',
              periodStart: student.admittedOn,
              periodEnd: student.admittedOn,
              dueDate: addDays(student.admittedOn, head.dueOffsetDays),
              termId: null,
            },
          ]
        : [];
    } else {
      periods = feePeriods(head, input.year, input.terms).filter(
        (p) => p.periodStart >= duesFrom && p.periodEnd >= student.admittedOn,
      );
    }

    for (const period of periods) {
      if (period.periodStart > limit) continue;
      const dueDate =
        student.admittedOn > period.periodStart
          ? maxDate(period.dueDate, addDays(student.admittedOn, LATE_JOINER_GRACE_DAYS))
          : period.dueDate;
      const manual =
        input.concessions.find(
          (c) =>
            c.feeHeadId === head.id &&
            c.validFrom <= dueDate &&
            (c.endedOn === null || dueDate < c.endedOn),
        ) ?? null;
      const sibling =
        head.siblingEligible &&
        input.sibling &&
        student.siblingRank !== null &&
        student.siblingRank >= input.sibling.fromChild
          ? input.sibling
          : null;
      const concession = effectiveConcession(amount, manual, sibling);
      planned.push({
        feeHeadId: head.id,
        periodKey: period.key,
        periodStart: period.periodStart,
        dueDate,
        termId: period.termId,
        amountPaisa: amount,
        concessionPaisa: concession.paisa,
        concessionSource: concession.source,
        concessionId: concession.source === 'MANUAL' ? manual!.id : null,
        fine: head.fine,
      });
    }
  }
  return planned;
}

// ───────────────────────────── Receipts ─────────────────────────────

/** "2026-000123": the receipt year and its sequence number (ASCII digits, an identifier). */
export function receiptNumber(year: number, seq: number): string {
  return `${year}-${String(seq).padStart(6, '0')}`;
}

// Bangla words for 0–99 are irregular, so they are listed (ten per row).
// prettier-ignore
const BN_0_99 = [
  'শূন্য', 'এক', 'দুই', 'তিন', 'চার', 'পাঁচ', 'ছয়', 'সাত', 'আট', 'নয়',
  'দশ', 'এগারো', 'বারো', 'তেরো', 'চৌদ্দ', 'পনেরো', 'ষোলো', 'সতেরো', 'আঠারো', 'উনিশ',
  'বিশ', 'একুশ', 'বাইশ', 'তেইশ', 'চব্বিশ', 'পঁচিশ', 'ছাব্বিশ', 'সাতাশ', 'আটাশ', 'ঊনত্রিশ',
  'ত্রিশ', 'একত্রিশ', 'বত্রিশ', 'তেত্রিশ', 'চৌত্রিশ', 'পঁয়ত্রিশ', 'ছত্রিশ', 'সাঁইত্রিশ', 'আটত্রিশ', 'ঊনচল্লিশ',
  'চল্লিশ', 'একচল্লিশ', 'বিয়াল্লিশ', 'তেতাল্লিশ', 'চুয়াল্লিশ', 'পঁয়তাল্লিশ', 'ছেচল্লিশ', 'সাতচল্লিশ', 'আটচল্লিশ', 'ঊনপঞ্চাশ',
  'পঞ্চাশ', 'একান্ন', 'বাহান্ন', 'তিপ্পান্ন', 'চুয়ান্ন', 'পঞ্চান্ন', 'ছাপ্পান্ন', 'সাতান্ন', 'আটান্ন', 'ঊনষাট',
  'ষাট', 'একষট্টি', 'বাষট্টি', 'তেষট্টি', 'চৌষট্টি', 'পঁয়ষট্টি', 'ছেষট্টি', 'সাতষট্টি', 'আটষট্টি', 'ঊনসত্তর',
  'সত্তর', 'একাত্তর', 'বাহাত্তর', 'তিয়াত্তর', 'চুয়াত্তর', 'পঁচাত্তর', 'ছিয়াত্তর', 'সাতাত্তর', 'আটাত্তর', 'ঊনআশি',
  'আশি', 'একাশি', 'বিরাশি', 'তিরাশি', 'চুরাশি', 'পঁচাশি', 'ছিয়াশি', 'সাতাশি', 'অষ্টাশি', 'ঊননব্বই',
  'নব্বই', 'একানব্বই', 'বিরানব্বই', 'তিরানব্বই', 'চুরানব্বই', 'পঁচানব্বই', 'ছিয়ানব্বই', 'সাতানব্বই', 'আটানব্বই', 'নিরানব্বই',
];

// prettier-ignore
const EN_ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen',
];
// prettier-ignore
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function en0to99(n: number): string {
  if (n < 20) return EN_ONES[n]!;
  const tens = EN_TENS[Math.floor(n / 10)]!;
  return n % 10 ? `${tens}-${EN_ONES[n % 10]}` : tens;
}

/** Words for a whole number in the lakh/crore system. */
function numberWords(n: number, locale: UiLocale): string {
  const small = (v: number) => (locale === 'bn' ? BN_0_99[v]! : en0to99(v));
  if (n < 100) return small(n);
  const units: [number, string, string][] = [
    [10_000_000, 'কোটি', 'crore'],
    [100_000, 'লক্ষ', 'lakh'],
    [1000, 'হাজার', 'thousand'],
    [100, 'শত', 'hundred'],
  ];
  const parts: string[] = [];
  let rest = n;
  for (const [size, bn, en] of units) {
    const count = Math.floor(rest / size);
    if (count === 0) continue;
    // Above 99 crore the crore count is itself a number in words.
    parts.push(
      `${size === 10_000_000 ? numberWords(count, locale) : small(count)} ${locale === 'bn' ? bn : en}`,
    );
    rest %= size;
  }
  if (rest > 0) parts.push(small(rest));
  return parts.join(' ');
}

/** An amount in words for receipts: "এক হাজার দুই শত পঞ্চাশ টাকা মাত্র" / "One thousand … taka only". */
export function amountInWords(paisa: number, locale: UiLocale): string {
  const taka = Math.floor(paisa / 100);
  const rest = paisa % 100;
  if (locale === 'bn') {
    const paisaPart = rest ? ` ${BN_0_99[rest]} পয়সা` : '';
    return `${numberWords(taka, 'bn')} টাকা${paisaPart} মাত্র`;
  }
  const words = `${numberWords(taka, 'en')} taka${rest ? ` and ${en0to99(rest)} paisa` : ''} only`;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ───────────────────────────── Identifiers ─────────────────────────────

/** "+8801811000101" → "018•••••101": enough to recognise a number someone already typed. */
export function maskPhone(e164: string): string {
  const local = e164.startsWith('+88') ? e164.slice(3) : e164;
  return `${local.slice(0, 3)}${'•'.repeat(Math.max(0, local.length - 6))}${local.slice(-3)}`;
}

const TRX_ID = /^[A-Z0-9]{6,20}$/;

/** A bKash/Nagad transaction ID as typed → upper case ASCII without spaces, or null. */
export function normalizeTrxId(input: string): string | null {
  const id = toAsciiDigits(input).replace(/[\s-]/g, '').toUpperCase();
  return TRX_ID.test(id) ? id : null;
}

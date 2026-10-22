/**
 * Fee module API (docs/fees.md): request schemas and response shapes. Money is integer paisa,
 * dates are `YYYY-MM-DD`. The rules themselves live in fees.ts.
 */
import { z } from 'zod';
import { isoDateSchema, type IsoDate } from './dates.js';
import { bdPhoneSchema } from './phone.js';
import {
  FEE_AMOUNT_TYPES,
  FEE_CONCESSION_CATEGORIES,
  FEE_FINE_TYPES,
  FEE_FREQUENCIES,
  FEE_HEAD_KINDS,
  MAX_FEE_PAISA,
  normalizeTrxId,
  type FeeAmountType,
  type FeeConcessionCategory,
  type FeeFineType,
  type FeeFrequency,
  type FeeHeadKind,
} from './fees.js';

const nameSchema = z.string().trim().min(1).max(100);
const reasonSchema = z.string().trim().min(3).max(500);
const paisaSchema = z.number().int().min(0).max(MAX_FEE_PAISA);
/** One fine step (the flat fine, or the per-day amount): at most ৳1 lakh. */
const fineStepSchema = z.number().int().min(0).max(10_000_000);
const firstOfMonth = (d: IsoDate) => d.endsWith('-01');

// ─────────────────────────── Settings ───────────────────────────

export const feeSiblingRuleSchema = z
  .object({
    type: z.enum(FEE_AMOUNT_TYPES),
    value: z.number().int().min(1).max(MAX_FEE_PAISA),
    fromChild: z.number().int().min(2).max(10).default(2),
  })
  .refine((r) => r.type === 'FIXED' || r.value <= 100, {
    message: 'A percentage is 1–100',
    path: ['value'],
  });

/** PUT /fees/settings (OWNER/ADMIN). */
export const feeSettingsSchema = z.object({
  /** First day of the first month that gets dues; null = no dues yet. */
  duesFrom: isoDateSchema.refine(firstOfMonth, 'Must be the 1st of a month').nullable(),
  receiptSmsEnabled: z.boolean(),
  sibling: feeSiblingRuleSchema.nullable(),
  receiptNote: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .transform((v) => v || null),
});
export type FeeSettingsInput = z.input<typeof feeSettingsSchema>;

export interface FeeSettingsView {
  duesFrom: IsoDate | null;
  receiptSmsEnabled: boolean;
  sibling: { type: FeeAmountType; value: number; fromChild: number } | null;
  receiptNote: string | null;
  /** False until an admin saves the settings (defaults until then). */
  saved: boolean;
}

// ─────────────────────────── Heads ───────────────────────────

export const feeFineRuleSchema = z.object({
  type: z.enum(FEE_FINE_TYPES),
  amountPaisa: fineStepSchema,
  capPaisa: paisaSchema.nullable(),
});

const feeHeadFields = {
  nameBn: nameSchema,
  nameEn: nameSchema,
  kind: z.enum(FEE_HEAD_KINDS),
  frequency: z.enum(FEE_FREQUENCIES),
  /** MONTHLY: the day of the month it falls due (1–28). Ignored for other frequencies. */
  dueDay: z.number().int().min(1).max(28).nullable(),
  /** YEARLY: days after the year starts; ONE_TIME: days after admission. */
  dueOffsetDays: z.number().int().min(0).max(365),
  /** ONE_TIME: charged automatically to students admitted on or after this date. */
  oneTimeFrom: isoDateSchema.nullable(),
  fine: feeFineRuleSchema,
  siblingEligible: z.boolean(),
  sortOrder: z.number().int().min(0).max(9999),
};

export interface FeeHeadShape {
  frequency: FeeFrequency;
  dueDay: number | null;
  oneTimeFrom: IsoDate | null;
  fine: { type: FeeFineType; amountPaisa: number; capPaisa: number | null };
}

/**
 * A head made consistent: fields that do not apply to its frequency are cleared. Returns the
 * problems that remain (a monthly head without a due day, a fine without an amount, a per-day
 * fine without a cap ≥ the daily amount), or none. Used for create and for a merged update.
 */
export function normalizeFeeHead<T extends FeeHeadShape>(head: T): { head: T; problems: string[] } {
  const fine =
    head.fine.type === 'NONE'
      ? { type: 'NONE' as const, amountPaisa: 0, capPaisa: null }
      : head.fine.type === 'FLAT'
        ? { ...head.fine, capPaisa: null }
        : head.fine;
  const out: T = {
    ...head,
    dueDay: head.frequency === 'MONTHLY' ? head.dueDay : null,
    oneTimeFrom: head.frequency === 'ONE_TIME' ? head.oneTimeFrom : null,
    fine,
  };
  const problems: string[] = [];
  if (out.frequency === 'MONTHLY' && out.dueDay === null) problems.push('dueDay');
  if (fine.type !== 'NONE' && fine.amountPaisa < 1) problems.push('fine.amountPaisa');
  if (fine.type === 'PER_DAY' && (fine.capPaisa === null || fine.capPaisa < fine.amountPaisa)) {
    problems.push('fine.capPaisa');
  }
  return { head: out, problems };
}

/** POST /fees/heads. */
export const createFeeHeadSchema = z
  .object({
    ...feeHeadFields,
    dueDay: feeHeadFields.dueDay.default(null),
    dueOffsetDays: feeHeadFields.dueOffsetDays.default(0),
    oneTimeFrom: feeHeadFields.oneTimeFrom.default(null),
    fine: feeFineRuleSchema.default({ type: 'NONE', amountPaisa: 0, capPaisa: null }),
    siblingEligible: feeHeadFields.siblingEligible.default(false),
    sortOrder: feeHeadFields.sortOrder.default(0),
  })
  .superRefine((head, ctx) => {
    for (const path of normalizeFeeHead(head).problems) {
      ctx.addIssue({
        code: 'custom',
        message: 'Required for this kind of fee',
        path: path.split('.'),
      });
    }
  });
/** PATCH /fees/heads/:id: any fields; the merged head is checked again (422 INVALID_HEAD). */
export const updateFeeHeadSchema = z
  .object(feeHeadFields)
  .partial()
  .extend({ isActive: z.boolean().optional() });
export type FeeHeadInput = z.input<typeof createFeeHeadSchema>;

export interface FeeHeadView {
  id: string;
  nameBn: string;
  nameEn: string;
  kind: FeeHeadKind;
  frequency: FeeFrequency;
  dueDay: number | null;
  dueOffsetDays: number;
  oneTimeFrom: IsoDate | null;
  fine: { type: FeeFineType; amountPaisa: number; capPaisa: number | null };
  siblingEligible: boolean;
  isActive: boolean;
  sortOrder: number;
}

// ─────────────────────────── Terms ───────────────────────────

const termFields = {
  nameBn: nameSchema,
  nameEn: nameSchema,
  opensOn: isoDateSchema,
  dueDate: isoDateSchema,
  sortOrder: z.number().int().min(0).max(9999),
};
/** POST /fees/terms. */
export const createFeeTermSchema = z
  .object({
    ...termFields,
    academicYearId: z.uuid(),
    sortOrder: termFields.sortOrder.default(0),
  })
  .refine((t) => t.dueDate >= t.opensOn, {
    message: 'Due date must be on or after the opening date',
    path: ['dueDate'],
  });
/** PATCH /fees/terms/:id (the merged dates are checked again). */
export const updateFeeTermSchema = z.object(termFields).partial();
export const feeTermsQuerySchema = z.object({ academicYearId: z.uuid().optional() });

export interface FeeTermView {
  id: string;
  academicYearId: string;
  nameBn: string;
  nameEn: string;
  opensOn: IsoDate;
  dueDate: IsoDate;
  sortOrder: number;
}

// ─────────────────────────── Amounts ───────────────────────────

export const feeAmountsQuerySchema = z.object({ academicYearId: z.uuid().optional() });

/** PUT /fees/amounts: set (or with null, remove) amounts of one year. */
export const setFeeAmountsSchema = z.object({
  academicYearId: z.uuid(),
  amounts: z
    .array(
      z.object({
        feeHeadId: z.uuid(),
        classLevelId: z.uuid(),
        studyGroupId: z.uuid().nullable().default(null),
        amountPaisa: paisaSchema.nullable(),
      }),
    )
    .min(1)
    .max(2000),
});
export type SetFeeAmountsInput = z.input<typeof setFeeAmountsSchema>;

/** POST /fees/amounts/copy: copy one year's amounts into another (only where none are set). */
export const copyFeeAmountsSchema = z
  .object({ fromAcademicYearId: z.uuid(), toAcademicYearId: z.uuid() })
  .refine((c) => c.fromAcademicYearId !== c.toAcademicYearId, {
    message: 'Pick another year',
    path: ['toAcademicYearId'],
  });

export interface FeeAmountRow {
  feeHeadId: string;
  classLevelId: string;
  studyGroupId: string | null;
  amountPaisa: number;
}

/** GET /fees/amounts: everything the price grid needs for one year. */
export interface FeeAmountsMatrix {
  academicYear: { id: string; name: string };
  heads: FeeHeadView[];
  classLevels: { id: string; nameBn: string; nameEn: string; sortOrder: number }[];
  studyGroups: { id: string; nameBn: string; nameEn: string; sortOrder: number }[];
  amounts: FeeAmountRow[];
}

// ─────────────────────────── Concessions ───────────────────────────

/** POST /fees/concessions. FREE_FULL / FREE_HALF set the percentage themselves. */
export const createFeeConcessionSchema = z
  .object({
    studentId: z.uuid(),
    feeHeadId: z.uuid(),
    /** Default: the current academic year. */
    academicYearId: z.uuid().optional(),
    category: z.enum(FEE_CONCESSION_CATEGORIES),
    type: z.enum(FEE_AMOUNT_TYPES).default('PERCENT'),
    value: z.number().int().min(1).max(MAX_FEE_PAISA).optional(),
    reason: z
      .string()
      .trim()
      .max(500)
      .nullish()
      .transform((v) => v || null),
    validFrom: isoDateSchema,
  })
  .transform((c) =>
    c.category === 'FREE_FULL'
      ? { ...c, type: 'PERCENT' as const, value: 100 }
      : c.category === 'FREE_HALF'
        ? { ...c, type: 'PERCENT' as const, value: 50 }
        : c,
  )
  .superRefine((c, ctx) => {
    if (c.value === undefined)
      ctx.addIssue({ code: 'custom', message: 'Required', path: ['value'] });
    else if (c.type === 'PERCENT' && c.value > 100) {
      ctx.addIssue({ code: 'custom', message: 'A percentage is 1–100', path: ['value'] });
    }
    if (c.category === 'SCHOLARSHIP' && (c.reason?.length ?? 0) < 3) {
      ctx.addIssue({ code: 'custom', message: 'A scholarship needs a reason', path: ['reason'] });
    }
  });
export type FeeConcessionInput = z.input<typeof createFeeConcessionSchema>;

/** POST /fees/concessions/:id/end. To cancel one that has not started, end it on its start. */
export const endFeeConcessionSchema = z.object({ endedOn: isoDateSchema, reason: reasonSchema });

export const feeConcessionsQuerySchema = z.object({
  studentId: z.uuid().optional(),
  academicYearId: z.uuid().optional(),
});

export interface FeeStudentRef {
  id: string;
  studentCode: string;
  nameBn: string | null;
  nameEn: string | null;
}

export interface FeeConcessionView {
  id: string;
  student: FeeStudentRef;
  feeHead: { id: string; nameBn: string; nameEn: string };
  academicYearId: string;
  category: FeeConcessionCategory;
  type: FeeAmountType;
  value: number;
  reason: string | null;
  validFrom: IsoDate;
  endedOn: IsoDate | null;
  endedReason: string | null;
  createdAt: string;
}

// ─────────────────────────── Siblings (confirmed families) ───────────────────────────

/** POST /fees/siblings: confirm these students as one family (joins an existing family). */
export const confirmSiblingsSchema = z.object({
  studentIds: z
    .array(z.uuid())
    .min(2)
    .max(10)
    .refine((ids) => new Set(ids).size === ids.length, 'Each student once'),
});
/** POST /fees/siblings/:groupId/members/:studentId/remove. */
export const removeSiblingSchema = z.object({ reason: reasonSchema });

export interface FeeFamilyMember extends FeeStudentRef {
  classLevel: { id: string; nameBn: string; nameEn: string } | null;
  /** 1 = pays full; from `fromChild` the sibling rule applies. */
  rank: number;
}

export interface FeeSiblingsView {
  families: { groupId: string; members: FeeFamilyMember[] }[];
  /**
   * Students sharing a guardian phone, not (all) in one family yet. A suggestion only: guardians
   * often give a relative's phone, so an admin confirms before any discount applies.
   */
  suggestions: {
    guardianName: string | null;
    phoneMasked: string;
    students: (FeeStudentRef & {
      classLevel: { id: string; nameBn: string; nameEn: string } | null;
    })[];
  }[];
}

// ─────────────────────────── Student search (counter, concessions) ───────────────────────────

export const feeStudentSearchSchema = z.object({ q: z.string().trim().min(1).max(80) });

export interface FeeStudentHit extends FeeStudentRef {
  status: 'ACTIVE' | 'INACTIVE' | 'GRADUATED' | 'TRANSFERRED' | 'DROPPED_OUT';
  enrolment: {
    classLevel: { id: string; nameBn: string; nameEn: string };
    section: { id: string; name: string } | null;
    roll: number | null;
  } | null;
  /** Primary guardian; the phone is masked for the accountant (decision #19). */
  guardian: { nameBn: string | null; nameEn: string | null; phone: string } | null;
}

// ─────────────────────────── Dues and the student ledger ───────────────────────────

/** GET /fees/students/:id/ledger. `upTo`: also show (and allow paying) periods up to this date. */
export const feeLedgerQuerySchema = z.object({ upTo: isoDateSchema.optional() });
/** POST /fees/dues/:id/cancel (OWNER/ADMIN): only a due with nothing paid. */
export const cancelFeeDueSchema = z.object({ reason: reasonSchema });
/** POST /fees/dues/:id/waive-fine (OWNER/ADMIN). `amountPaisa` null: the whole fine, for good. */
export const waiveFeeFineSchema = z.object({
  amountPaisa: z.number().int().min(1).max(MAX_FEE_PAISA).nullable(),
  reason: reasonSchema,
});
/** POST /fees/dues/recalculate (OWNER/ADMIN): rewrite unpaid dues from today's setup. */
export const recalculateFeeDuesSchema = z.object({
  /** Only these students (e.g. a family just confirmed); default: everyone. */
  studentIds: z.array(z.uuid()).min(1).max(50).optional(),
});

export interface FeeDueView {
  id: string;
  head: { id: string; nameBn: string; nameEn: string; kind: FeeHeadKind };
  academicYear: { id: string; name: string };
  periodKey: string;
  /** Term dues: the term's names. */
  term: { nameBn: string; nameEn: string } | null;
  periodStart: IsoDate;
  dueDate: IsoDate;
  amountPaisa: number;
  concessionPaisa: number;
  concessionSource: 'NONE' | 'MANUAL' | 'SIBLING';
  paidPrincipalPaisa: number;
  paidFinePaisa: number;
  fineWaivedPaisa: number;
  fineWaivedAll: boolean;
  principalClearedOn: IsoDate | null;
  /** What is still owed today: principal, fine (accrued − paid − waived) and their sum. */
  balance: { principal: number; fine: number; total: number };
  status: 'OPEN' | 'CANCELLED';
  cancelReason: string | null;
  /** Past its due date with something still owed. */
  overdue: boolean;
}

/** A period not generated yet that can be paid ahead (current year only). */
export interface FeeUpcomingDue {
  headId: string;
  head: { nameBn: string; nameEn: string };
  periodKey: string;
  term: { nameBn: string; nameEn: string } | null;
  periodStart: IsoDate;
  dueDate: IsoDate;
  amountPaisa: number;
  concessionPaisa: number;
}

export interface FeeWaiverView {
  id: string;
  dueId: string;
  amountPaisa: number | null;
  reason: string;
  createdAt: string;
}

export interface FeeLedger {
  /** Today in the institute's timezone. */
  today: IsoDate;
  student: FeeStudentHit;
  family: { groupId: string; rank: number } | null;
  /** Every due (earlier years' arrears too), oldest first; cancelled ones stay visible. */
  dues: FeeDueView[];
  upcoming: FeeUpcomingDue[];
  concessions: FeeConcessionView[];
  waivers: FeeWaiverView[];
  /** Receipts, newest first (void ones included). */
  payments: FeePaymentSummary[];
  totals: { charged: number; concession: number; paid: number; balance: number; overdue: number };
}

// ─────────────────────────── Collection, receipts, void, closing ───────────────────────────

export const FEE_PAYMENT_METHODS = ['CASH', 'BKASH', 'NAGAD'] as const;
export type FeePaymentMethod = (typeof FEE_PAYMENT_METHODS)[number];

/** POST /fees/payments (OWNER/ADMIN/ACCOUNTANT): cash at the counter for one student. */
export const collectFeeSchema = z
  .object({
    studentId: z.uuid(),
    dueIds: z.array(z.uuid()).max(60).default([]),
    /** Periods paid ahead (from the ledger's `upcoming`): created inside the payment. */
    advance: z
      .array(z.object({ headId: z.uuid(), periodKey: z.string().min(1).max(60) }))
      .max(24)
      .default([]),
    amountPaisa: z.number().int().min(1).max(1_000_000_000),
    /** What the counter showed as owed for the chosen dues (409 DUES_CHANGED if it moved). */
    expectedOutstandingPaisa: z.number().int().min(0),
    /** New for every attempt; a retried request returns the same receipt. */
    clientRequestId: z.uuid(),
  })
  .refine((c) => c.dueIds.length + c.advance.length > 0, {
    message: 'Choose at least one due',
    path: ['dueIds'],
  });
export type CollectFeeInput = z.input<typeof collectFeeSchema>;

/** POST /fees/payments/:id/void (OWNER/ADMIN). */
export const voidFeePaymentSchema = z.object({ reason: reasonSchema });

export const feeClosingQuerySchema = z.object({
  date: isoDateSchema.optional(),
  collectorId: z.uuid().optional(),
});

export interface FeeReceiptLine {
  dueId: string;
  head: { nameBn: string; nameEn: string };
  periodKey: string;
  term: { nameBn: string; nameEn: string } | null;
  principalPaisa: number;
  finePaisa: number;
}

export interface FeeReceipt {
  id: string;
  /** "2026-000123" (ASCII: an identifier). */
  receiptNumber: string;
  status: 'ACTIVE' | 'VOID';
  void: {
    at: string;
    reason: string;
    by: { id: string; name: string; nameBn: string | null };
  } | null;
  method: FeePaymentMethod;
  channel: 'COUNTER' | 'MOBILE_MANUAL';
  trxId: string | null;
  /** The sender's number, masked. */
  senderPhone: string | null;
  amountPaisa: number;
  paidOn: IsoDate;
  recordedOn: IsoDate;
  createdAt: string;
  institute: { name: string; receiptNote: string | null };
  student: FeeStudentRef & {
    classLevel: { nameBn: string; nameEn: string } | null;
    section: string | null;
    roll: number | null;
  };
  lines: FeeReceiptLine[];
  collectedBy: { id: string; name: string; nameBn: string | null } | null;
  /** The student's balance today (not at the time of the receipt). */
  balanceTodayPaisa: number;
  /** A retried request answered with the receipt it already made. */
  replayed?: boolean;
}

export interface FeePaymentSummary {
  id: string;
  receiptNumber: string;
  status: 'ACTIVE' | 'VOID';
  method: FeePaymentMethod;
  amountPaisa: number;
  paidOn: IsoDate;
  recordedOn: IsoDate;
}

export interface FeeClosingCollector {
  collector: { id: string; name: string; nameBn: string | null };
  /** Payments recorded that day, void ones included (a void counts on the day it is made). */
  collected: { count: number; amountPaisa: number };
  /** Voids made that day of this collector's payments (of any day): deducted from that day. */
  voided: {
    id: string;
    receiptNumber: string;
    amountPaisa: number;
    reason: string;
    recordedOn: IsoDate;
  }[];
  /** Per method: receipts recorded that day, and collected − voided that day. */
  byMethod: { method: FeePaymentMethod; count: number; amountPaisa: number }[];
  /** What should be in hand for the day: collected − voided. */
  net: { amountPaisa: number };
  /** First and last receipt numbers recorded that day. */
  receipts: { first: string; last: string } | null;
}

/**
 * GET /fees/closing: one day per collector and method. A payment counts on the day it was
 * recorded; a later void is deducted on the day it is made, so a closed day never changes.
 */
export interface FeeClosing {
  date: IsoDate;
  collectors: FeeClosingCollector[];
  total: { collectedPaisa: number; voidedPaisa: number; netPaisa: number };
}

// ─────────────────────────── Manual bKash/Nagad ───────────────────────────

export const FEE_MOBILE_METHODS = ['BKASH', 'NAGAD'] as const;
export type FeeMobileMethod = (typeof FEE_MOBILE_METHODS)[number];
export const FEE_MOBILE_ACCOUNT_KINDS = ['PERSONAL', 'MERCHANT', 'AGENT'] as const;

/** POST /fees/mobile-accounts (OWNER): the institute's own number. */
export const createMobileAccountSchema = z.object({
  method: z.enum(FEE_MOBILE_METHODS),
  phone: bdPhoneSchema,
  kind: z.enum(FEE_MOBILE_ACCOUNT_KINDS),
  label: z
    .string()
    .trim()
    .max(60)
    .nullish()
    .transform((v) => v || null),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
/** PATCH /fees/mobile-accounts/:id (OWNER): a number is never edited, only (de)activated. */
export const updateMobileAccountSchema = z.object({
  label: z
    .string()
    .trim()
    .max(60)
    .nullish()
    .transform((v) => v || null),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export interface FeeMobileAccountView {
  id: string;
  method: FeeMobileMethod;
  phone: string;
  kind: (typeof FEE_MOBILE_ACCOUNT_KINDS)[number];
  label: string | null;
  isActive: boolean;
  sortOrder: number;
}

/** A transaction ID as typed (Bangla digits, spaces, lower case accepted). */
export const trxIdSchema = z.string().transform((value, ctx) => {
  const id = normalizeTrxId(value);
  if (!id) {
    ctx.addIssue({ code: 'custom', message: 'A TrxID is 6–20 letters and digits' });
    return z.NEVER;
  }
  return id;
});

const submissionFields = {
  method: z.enum(FEE_MOBILE_METHODS),
  accountId: z.uuid(),
  amountPaisa: z.number().int().min(1).max(1_000_000_000),
  trxId: trxIdSchema,
  senderPhone: bdPhoneSchema,
  dueIds: z.array(z.uuid()).min(1).max(24),
  clientRequestId: z.uuid(),
};
/** POST /me/children/:id/fees/submissions (the guardian). */
export const guardianSubmissionSchema = z.object(submissionFields);
/** POST /fees/submissions (staff, for a student). */
export const staffSubmissionSchema = z.object({ ...submissionFields, studentId: z.uuid() });
export type FeeSubmissionInput = z.input<typeof guardianSubmissionSchema>;

export const FEE_SUBMISSION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED', 'VOIDED'] as const;
export const feeSubmissionsQuerySchema = z.object({
  status: z.enum(FEE_SUBMISSION_STATUSES).optional(),
});

/**
 * POST /fees/submissions/:id/verify: checked in the institute's own app → a payment and receipt.
 * The dues may be re-picked (and months paid ahead) when the original ones were paid meanwhile.
 */
export const verifySubmissionSchema = z.object({
  clientRequestId: z.uuid(),
  dueIds: z.array(z.uuid()).max(24).optional(),
  advance: z
    .array(z.object({ headId: z.uuid(), periodKey: z.string().min(1).max(60) }))
    .max(24)
    .default([]),
});
export const rejectSubmissionSchema = z.object({ reason: reasonSchema });

export interface FeeSubmissionView {
  id: string;
  student: FeeStudentRef & { classLevel: { nameBn: string; nameEn: string } | null };
  method: FeeMobileMethod;
  account: { id: string; phone: string; label: string | null };
  amountPaisa: number;
  trxId: string;
  /** Masked for the accountant (decision #19). */
  senderPhone: string;
  sentOn: IsoDate;
  submitter: 'GUARDIAN' | 'STAFF';
  status: (typeof FEE_SUBMISSION_STATUSES)[number];
  dues: {
    id: string;
    head: { nameBn: string; nameEn: string };
    periodKey: string;
    term: { nameBn: string; nameEn: string } | null;
  }[];
  rejectReason: string | null;
  reviewedAt: string | null;
  receipt: { id: string; receiptNumber: string } | null;
  createdAt: string;
}

/** GET /me/children/:id/fees: a guardian's view of one child's fees. */
export interface FeeGuardianView {
  today: IsoDate;
  ledger: FeeLedger;
  submissions: FeeSubmissionView[];
  /** Where to send money: the institute's active numbers. */
  accounts: Pick<FeeMobileAccountView, 'id' | 'method' | 'phone' | 'kind' | 'label'>[];
}

// ─────────────────────────── Reports, reminders, dashboard ───────────────────────────

const flag = z
  .enum(['0', '1', 'true', 'false'])
  .optional()
  .transform((v) => v === '1' || v === 'true');

/** GET /fees/reports/dues: who owes what, by class/section (defaulters: overdueOnly=1). */
export const feeDueListQuerySchema = z.object({
  classLevelId: z.uuid().optional(),
  sectionId: z.uuid().optional(),
  /** Only students with something overdue for at least `minDays` and `minAmountPaisa`. */
  overdueOnly: flag,
  minDays: z.coerce.number().int().min(0).max(3650).default(0),
  minAmountPaisa: z.coerce.number().int().min(0).max(1_000_000_000).default(0),
  locale: z.enum(['bn', 'en']).default('bn'),
});

export interface FeeDueListRow {
  student: FeeStudentRef;
  classLevel: { id: string; nameBn: string; nameEn: string } | null;
  section: { id: string; name: string } | null;
  roll: number | null;
  /** Primary guardian; the phone masked for the accountant. */
  guardian: { nameBn: string | null; nameEn: string | null; phone: string } | null;
  openDues: number;
  principalPaisa: number;
  finePaisa: number;
  totalPaisa: number;
  overduePaisa: number;
  oldestOverdue: IsoDate | null;
}

export interface FeeDueList {
  today: IsoDate;
  rows: FeeDueListRow[];
  totals: {
    students: number;
    principalPaisa: number;
    finePaisa: number;
    totalPaisa: number;
    overduePaisa: number;
  };
}

export const FEE_COLLECTION_GROUPS = ['day', 'month', 'head', 'method', 'collector'] as const;
/** GET /fees/reports/collections: money kept (void payments left out), recorded in a range. */
export const feeCollectionsQuerySchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    groupBy: z.enum(FEE_COLLECTION_GROUPS),
    locale: z.enum(['bn', 'en']).default('bn'),
  })
  .refine((q) => q.to >= q.from, { message: 'The end is before the start', path: ['to'] })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 366 * 86_400_000, {
    message: 'At most a year',
    path: ['to'],
  });

export interface FeeCollectionRow {
  /** 'YYYY-MM-DD', 'YYYY-MM', a method, a head id or a collector id. */
  key: string;
  nameBn: string | null;
  nameEn: string | null;
  /** Receipts (for heads: receipts that paid that head). */
  count: number;
  amountPaisa: number;
}

export interface FeeCollections {
  from: IsoDate;
  to: IsoDate;
  groupBy: (typeof FEE_COLLECTION_GROUPS)[number];
  rows: FeeCollectionRow[];
  total: { count: number; amountPaisa: number };
}

/** Due reminders (OWNER/ADMIN): who is overdue, in a class/section or the whole institute. */
export const feeReminderFilterSchema = z.object({
  classLevelId: z.uuid().optional(),
  sectionId: z.uuid().optional(),
  minDays: z.number().int().min(1).max(3650).default(1),
});
/** POST /fees/reminders: send after the preview; refused (409) when the count changed. */
export const sendFeeRemindersSchema = feeReminderFilterSchema.extend({
  expectedRecipients: z.number().int().min(0),
});

export interface FeeReminderPreview {
  /** Students with something overdue. */
  students: number;
  withoutPhone: number;
  /** Already reminded for their latest overdue period (never twice). */
  alreadyReminded: number;
  toSend: number;
  segments: number;
  costPaisa: number;
  /** SMS left under today's cap, and how many of these would be held over it. */
  capLeftToday: number;
  wouldBeHeld: number;
  /** One message as it will read (the first student). */
  sampleText: string | null;
}

export interface FeeReminderRun {
  runId: string;
  queued: number;
}

export interface FeeReminderStatus {
  runId: string;
  counts: Record<
    'QUEUED' | 'SENT' | 'FAILED' | 'CANCELLED' | 'HELD_OVER_LIMIT' | 'EXPIRED',
    number
  >;
}

/** GET /fees/summary: the dashboard's fee card. */
export interface FeeSummary {
  today: IsoDate;
  /** Kept this month so far (void payments left out). */
  month: { collectedPaisa: number; count: number };
  /** The same days of last month, for comparison. */
  previousMonthToDate: { collectedPaisa: number };
  overdue: { paisa: number; students: number };
  pendingSubmissions: number;
}

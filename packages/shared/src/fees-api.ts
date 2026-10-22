/**
 * Fee module API (docs/fees.md): request schemas and response shapes. Money is integer paisa,
 * dates are `YYYY-MM-DD`. The rules themselves live in fees.ts.
 */
import { z } from 'zod';
import { isoDateSchema, type IsoDate } from './dates.js';
import {
  FEE_AMOUNT_TYPES,
  FEE_CONCESSION_CATEGORIES,
  FEE_FINE_TYPES,
  FEE_FREQUENCIES,
  FEE_HEAD_KINDS,
  MAX_FEE_PAISA,
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
  totals: { charged: number; concession: number; paid: number; balance: number; overdue: number };
}

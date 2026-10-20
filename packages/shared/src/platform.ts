import { z } from 'zod';
import { isoDateSchema, type IsoDate } from './dates.js';
import { bdPhoneSchema } from './phone.js';
import { monthSchema } from './reports.js';

/** A month (YYYY-MM) the platform deals with: 2020 to 2100 (a year 0000 is not a date). */
const platformMonthSchema = monthSchema.refine((m) => m >= '2020-01' && m <= '2100-12', {
  message: 'Out of range',
});

// Platform area (/platform): Jantrik's own staff. Separate login (password + TOTP), separate
// session (an httpOnly cookie), never an institute user. See docs/platform.md.

/** Every platform request sends this as X-Jantrik-Client (CSRF defence with SameSite=Strict). */
export const PLATFORM_CLIENT = 'platform';

/** POST /platform/auth/login: step 1. */
export const platformLoginSchema = z.object({
  /** Phone (any common BD format) or email. */
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
});

/** POST /platform/auth/verify: step 2, a 6-digit authenticator code or a backup code. */
export const platformVerifySchema = z.object({
  challengeId: z.string().min(20).max(100),
  code: z.string().trim().min(6).max(12),
});

export interface PlatformLoginResponse {
  challengeId: string;
  /** Only on the first login: set up the authenticator app (QR code of `uri`, or the key). */
  enrol?: { secret: string; uri: string };
}

export interface PlatformAdminInfo {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  totpEnabledAt: string | null;
  backupCodesLeft: number;
  /** The session's hard end (8 h after login). */
  sessionExpiresAt: string | null;
}

export interface PlatformVerifyResponse {
  admin: PlatformAdminInfo;
  /** Only right after enrolment: the 10 one-time backup codes, shown once. */
  backupCodes?: string[];
}

export const platformAuditQuerySchema = z.object({
  /** Keyset paging: the last row's createdAt and id. */
  before: z.iso.datetime().optional(),
  beforeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface PlatformAuditEntry {
  id: string;
  createdAt: string;
  actor: 'ADMIN' | 'CLI';
  adminName: string | null;
  action: string;
  targetTenantId: string | null;
  targetTenantName: string | null;
  entity: string | null;
  entityId: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
}

// ─────────────────────────── Institutes (part 2) ───────────────────────────

/** Modules the platform switches on or off; CORE is always on. */
export const PLATFORM_MODULES = ['ATTENDANCE', 'FEES', 'EXAMS'] as const;
export type PlatformModule = (typeof PLATFORM_MODULES)[number];
export const INSTITUTE_STATUS_VALUES = ['TRIAL', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;
export type InstituteStatus = (typeof INSTITUTE_STATUS_VALUES)[number];

/** Slugs that would clash with app routes or future subdomains. */
export const RESERVED_SLUGS: readonly string[] = [
  'admin',
  'api',
  'app',
  'assets',
  'docs',
  'help',
  'jantrik',
  'login',
  'mail',
  'platform',
  'setup',
  'static',
  'status',
  'support',
  'www',
];

/** An institute's short name in links: lowercase letters, digits and single hyphens. */
export const instituteSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Lowercase letters, digits and single hyphens')
  .refine((s) => !RESERVED_SLUGS.includes(s), 'This name is reserved');

const paisa = z.number().int().min(0).max(100_000_000);

/** Pricing in paisa. PER_STUDENT: per active student per month, per enabled module. */
export const platformPlanSchema = z.object({
  planName: z.string().trim().min(1).max(60),
  pricing: z.enum(['PER_STUDENT', 'FLAT']),
  corePaisa: paisa.default(0),
  attendancePaisa: paisa.default(0),
  feesPaisa: paisa.default(0),
  examsPaisa: paisa.default(0),
  flatPaisa: paisa.default(0),
  cycle: z.enum(['MONTHLY', 'YEARLY']).default('MONTHLY'),
  yearlyDiscountPercent: z.number().int().min(0).max(100).default(0),
  dueDays: z.number().int().min(1).max(90).default(10),
});
export type PlatformPlanInput = z.input<typeof platformPlanSchema>;

/** PUT /platform/institutes/:id/limits. Null: no limit. */
export const platformLimitsSchema = z.object({
  studentLimit: z.number().int().min(1).max(1_000_000).nullable(),
  smsDailyCap: z.number().int().min(0).max(1_000_000).nullable(),
});
export type PlatformLimits = z.infer<typeof platformLimitsSchema>;

/** The owner the platform invites (the institute's name for them: a staff profile). */
export const platformOwnerSchema = z.object({
  phone: bdPhoneSchema,
  name: z.string().trim().min(1).max(100),
  nameBn: z
    .string()
    .trim()
    .max(100)
    .nullish()
    .transform((v) => v || null),
});
export type PlatformOwnerInput = z.input<typeof platformOwnerSchema>;

/** POST /platform/institutes. */
export const platformCreateInstituteSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: instituteSlugSchema,
  instituteTypeKey: z.string().trim().min(1).max(60),
  modules: z
    .array(z.enum(PLATFORM_MODULES))
    .max(PLATFORM_MODULES.length)
    .refine((m) => new Set(m).size === m.length, 'Duplicate module')
    .default([]),
  owner: platformOwnerSchema,
  plan: platformPlanSchema,
  /** Null: no end date yet. The institute stays in TRIAL until activated (decision 6). */
  trialEndsOn: isoDateSchema.nullable().default(null),
  /** The first academic year; the current calendar year when omitted. */
  academicYear: z
    .object({
      name: z.string().trim().min(1).max(40),
      startDate: isoDateSchema,
      endDate: isoDateSchema,
    })
    .refine((y) => y.endDate > y.startDate, { message: 'End before start', path: ['endDate'] })
    .optional(),
  limits: platformLimitsSchema.default({ studentLimit: null, smsDailyCap: null }),
});
export type PlatformCreateInstituteInput = z.input<typeof platformCreateInstituteSchema>;

/** POST /platform/institutes/:id/suspend and /reactivate. */
export const platformStatusChangeSchema = z.object({ reason: z.string().trim().min(3).max(500) });

/** PUT /platform/institutes/:id/modules/:module. */
export const platformModuleSchema = z.object({ enabled: z.boolean() });

/** GET /platform/institutes. */
export const platformInstituteListQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  type: z.string().trim().max(60).optional(),
  status: z.enum(INSTITUTE_STATUS_VALUES).optional(),
  plan: z.string().trim().max(60).optional(),
  /** Still in TRIAL after the trial end date. */
  trialEnded: z.stringbool().optional(),
  /** Has an invoice past its due date. */
  overdue: z.stringbool().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type PlatformInstituteListQuery = z.input<typeof platformInstituteListQuerySchema>;

export interface PlatformInstituteType {
  key: string;
  nameBn: string;
  nameEn: string;
}

export interface PlatformInstituteOptions {
  types: PlatformInstituteType[];
  /** Plan names in use (for the list filter). */
  plans: string[];
}

/** The owner's invitation as the platform sees it (EXPIRED: 14 days without an answer). */
export type PlatformOwnerStatus = 'ACTIVE' | 'DISABLED' | 'INVITED' | 'EXPIRED' | 'DECLINED';

export interface PlatformInstituteOwner {
  userId: string;
  name: string | null;
  nameBn: string | null;
  phone: string | null;
  status: PlatformOwnerStatus;
  invitedAt: string | null;
  inviteExpiresAt: string | null;
}

export interface PlatformInstituteListItem {
  id: string;
  name: string;
  slug: string;
  type: PlatformInstituteType;
  status: InstituteStatus;
  planName: string | null;
  trialEndsOn: IsoDate | null;
  /** Still in TRIAL after trialEndsOn (a warning; it stays in trial, decision 6). */
  trialEnded: boolean;
  createdAt: string;
  owner: Omit<PlatformInstituteOwner, 'userId' | 'inviteExpiresAt'> | null;
  activeStudents: number;
  smsThisMonth: number;
  /** Invoices past their due date, and what is still owed on them. */
  overdueCount: number;
  overduePaisa: number;
}

export interface PlatformInstitutePage {
  items: PlatformInstituteListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PlatformSubscription {
  planName: string | null;
  pricing: 'PER_STUDENT' | 'FLAT';
  corePaisa: number;
  attendancePaisa: number;
  feesPaisa: number;
  examsPaisa: number;
  flatPaisa: number;
  cycle: 'MONTHLY' | 'YEARLY';
  yearlyDiscountPercent: number;
  dueDays: number;
  trialEndsOn: IsoDate | null;
  studentLimit: number | null;
  smsDailyCap: number | null;
  /** The first month invoiced (its first day); null until activation. */
  billingStartsOn: IsoDate | null;
}

export interface PlatformInstituteDetail {
  id: string;
  name: string;
  slug: string;
  status: InstituteStatus;
  /** While suspended: the status reactivation returns to. */
  suspendedFrom: 'TRIAL' | 'ACTIVE' | null;
  suspendedAt: string | null;
  timezone: string;
  defaultLocale: 'bn' | 'en';
  createdAt: string;
  type: PlatformInstituteType;
  modules: { key: 'CORE' | PlatformModule; enabled: boolean; enabledAt: string | null }[];
  /** Null: created before plans existed (no plan, no limits). */
  subscription: PlatformSubscription | null;
  trialEnded: boolean;
  /** Unpaid invoices (ISSUED), and those past their due date. */
  billing: { openCount: number; openPaisa: number; overdueCount: number; overduePaisa: number };
  owners: PlatformInstituteOwner[];
  counts: {
    activeStudents: number;
    activeStaff: number;
    smsThisMonth: number;
    smsSegmentsThisMonth: number;
    /** SMS sent this month × the rate when each was sent (part 4). */
    smsCostThisMonth: number;
    importsThisMonth: number;
    importsTotal: number;
    lastActivityAt: string | null;
  };
}

// ─────────────────────────── Billing (part 3) ───────────────────────────

/** PUT /platform/institutes/:id/plan: the plan, its trial end and the first month invoiced. */
export const platformSetPlanSchema = platformPlanSchema.extend({
  trialEndsOn: isoDateSchema.nullable(),
  /** The first day of a month, or null (not billed yet). */
  billingStartsOn: isoDateSchema
    .refine((d) => d.endsWith('-01'), 'The first day of a month')
    .nullable(),
});
export type PlatformSetPlanInput = z.input<typeof platformSetPlanSchema>;

export const INVOICE_STATUS_VALUES = ['ISSUED', 'PAID', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUS_VALUES)[number];
export const PAYMENT_METHOD_VALUES = ['CASH', 'BKASH', 'BANK'] as const;
export type PaymentMethod = (typeof PAYMENT_METHOD_VALUES)[number];

/** POST /platform/invoices/generate: one month's invoices (idempotent). */
export const platformGenerateInvoicesSchema = z.object({
  month: platformMonthSchema,
  /** The issue date; today when omitted. Never in the future. */
  issuedOn: isoDateSchema.nullable().default(null),
});

export interface PlatformGenerateResult {
  created: number;
  /**
   * Why institutes got none: trial, suspended (or archived), noPlan, notStarted, exists (a live
   * invoice already covers those months), free (nothing to pay), tooLarge (check the prices).
   */
  skipped: Partial<
    Record<'trial' | 'suspended' | 'noPlan' | 'notStarted' | 'exists' | 'free' | 'tooLarge', number>
  >;
}

/** GET /platform/invoices. */
export const platformInvoiceListQuerySchema = z.object({
  tenantId: z.uuid().optional(),
  status: z.enum(INVOICE_STATUS_VALUES).optional(),
  overdue: z.stringbool().optional(),
  month: platformMonthSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type PlatformInvoiceListQuery = z.input<typeof platformInvoiceListQuerySchema>;

/** POST /platform/invoices/:id/payments. */
export const platformPaymentSchema = z.object({
  /** Up to what an invoice can hold; the API refuses more than is left to pay. */
  amountPaisa: z.number().int().min(1).max(2_147_483_647),
  method: z.enum(PAYMENT_METHOD_VALUES),
  reference: z
    .string()
    .trim()
    .max(100)
    .nullish()
    .transform((v) => v || null),
  paidOn: isoDateSchema,
});
export type PlatformPaymentInput = z.input<typeof platformPaymentSchema>;

/** POST /platform/invoices/:id/void. */
export const platformVoidSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export interface PlatformInvoiceListItem {
  id: string;
  tenant: { id: string; name: string; slug: string };
  periodStart: IsoDate;
  periodEnd: IsoDate;
  cycle: 'MONTHLY' | 'YEARLY';
  issuedOn: IsoDate;
  dueOn: IsoDate;
  status: InvoiceStatus;
  totalPaisa: number;
  paidPaisa: number;
  /** ISSUED and past its due date (computed). */
  overdue: boolean;
}

export interface PlatformInvoicePage {
  items: PlatformInvoiceListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PlatformInvoiceLine {
  kind: 'CORE' | 'ATTENDANCE' | 'FEES' | 'EXAMS' | 'FLAT' | 'DISCOUNT';
  /** Per-student lines: the active students counted when the invoice was made. */
  activeStudents: number | null;
  unitPaisa: number;
  months: number;
  /** Negative for the yearly discount. */
  amountPaisa: number;
}

export interface PlatformPayment {
  id: string;
  amountPaisa: number;
  method: PaymentMethod;
  reference: string | null;
  paidOn: IsoDate;
  recordedBy: string | null;
  createdAt: string;
}

export interface PlatformInvoiceDetail extends PlatformInvoiceListItem {
  voidReason: string | null;
  voidedAt: string | null;
  lines: PlatformInvoiceLine[];
  payments: PlatformPayment[];
}

/** GET /me/billing-notice (OWNER): Jantrik's invoices past their due date, if any. */
export interface BillingNotice {
  overdue: { count: number; duePaisa: number; oldestDueOn: IsoDate } | null;
}

// ─────────────────────────── Usage and cost (part 4) ───────────────────────────

/** PUT /platform/settings: what one SMS segment costs Jantrik from now on (paisa, at most ৳100). */
export const platformSettingsSchema = z.object({
  smsCostPerSegmentPaisa: z.number().int().min(0).max(10_000),
});
export type PlatformSettingsInput = z.input<typeof platformSettingsSchema>;

export interface PlatformSettings {
  smsCostPerSegmentPaisa: number;
  updatedAt: string;
  updatedBy: string | null;
}

/** GET /platform/usage. */
export const platformUsageQuerySchema = z.object({
  month: platformMonthSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type PlatformUsageQuery = z.input<typeof platformUsageQuerySchema>;

export interface PlatformSmsTotals {
  count: number;
  segments: number;
  /** Segments × the rate when each SMS was sent. */
  costPaisa: number;
}

export interface PlatformUsageInstitute {
  id: string;
  name: string;
  slug: string;
  status: InstituteStatus;
  activeStudents: number;
  smsSent: number;
  smsSegments: number;
  smsCostPaisa: number;
  importsThisMonth: number;
  lastActivityAt: string | null;
}

export interface PlatformUsage {
  /** YYYY-MM */
  month: string;
  institutes: { total: number; active: number; trial: number; suspended: number };
  activeStudents: number;
  /** SMS institutes sent (absence alerts and the like). */
  institutesSms: PlatformSmsTotals;
  /** Login codes (OTP), paid by Jantrik. */
  loginSms: PlatformSmsTotals;
  totalCostPaisa: number;
  /** The rate now (past SMS keep the rate they were sent at). */
  smsCostPerSegmentPaisa: number;
  /** Per institute, the most expensive first. */
  items: PlatformUsageInstitute[];
  total: number;
  page: number;
  pageSize: number;
}

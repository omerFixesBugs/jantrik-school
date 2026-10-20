import { z } from 'zod';
import { isoDateSchema, type IsoDate } from './dates.js';
import { bdPhoneSchema } from './phone.js';

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
  owners: PlatformInstituteOwner[];
  counts: {
    activeStudents: number;
    activeStaff: number;
    smsThisMonth: number;
    smsSegmentsThisMonth: number;
    importsThisMonth: number;
    importsTotal: number;
    lastActivityAt: string | null;
  };
}

import { z } from 'zod';
import type { Role } from './auth.js';
import { toAsciiDigits } from './digits.js';

/** Header the web app sends with the tenant a page was loaded for. */
export const TENANT_HEADER = 'X-Jantrik-Tenant';
/** Error code (409) when that header differs from the access token's tenant. */
export const TENANT_MISMATCH = 'TENANT_MISMATCH';

export type ModuleKey = 'CORE' | 'ATTENDANCE' | 'FEES' | 'EXAMS';

/** GET /me/context — everything the web shell needs after login or switch. */
export interface MeContext {
  tenant: {
    id: string;
    slug: string;
    name: string;
    defaultLocale: 'bn' | 'en';
    instituteType: { key: string; nameBn: string; nameEn: string };
  };
  /** Tenant's UI labels, e.g. `section` → { bn: 'ব্যাচ', en: 'Batch' } for coaching. */
  labels: Record<string, { bn: string; en: string }>;
  modules: ModuleKey[];
  roles: Role[];
  academicYear: { id: string; name: string; startDate: string; endDate: string } | null;
  /** Today in the tenant's timezone (YYYY-MM-DD). Never use the device date. */
  today: string;
}

export const preferencesSchema = z.object({
  locale: z.enum(['bn', 'en']),
});

export const STUDENT_STATUSES = [
  'ACTIVE',
  'INACTIVE',
  'GRADUATED',
  'TRANSFERRED',
  'DROPPED_OUT',
] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

/**
 * How GET /students can be ordered. `class`: class order, then section, then roll; `roll`: roll
 * first (the register's order when one section is chosen). Students with no name or roll, and
 * those not enrolled this year, come last in either direction.
 */
export const STUDENT_SORTS = ['code', 'name', 'class', 'roll'] as const;
export type StudentSort = (typeof STUDENT_SORTS)[number];

export const STUDENTS_PAGE_SIZE = 50;

/** GET /students query. Bangla digits in the search are accepted. */
export const studentsQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(100)
    .transform((v) => toAsciiDigits(v))
    .optional(),
  classLevelId: z.uuid().optional(),
  sectionId: z.uuid().optional(),
  status: z.enum(STUDENT_STATUSES).optional(),
  sort: z.enum(STUDENT_SORTS).default('code'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  /** For `sort=name`: Bangla names first (bn) or English names first (en). */
  locale: z.enum(['bn', 'en']).default('bn'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(STUDENTS_PAGE_SIZE),
});
export type StudentsQuery = z.input<typeof studentsQuerySchema>;

export interface StudentListItem {
  id: string;
  studentCode: string;
  nameBn: string | null;
  nameEn: string | null;
  status: StudentStatus;
  photoUrl: string | null;
  enrolment: {
    classLevel: { id: string; nameBn: string; nameEn: string };
    section: { id: string; name: string } | null;
    roll: number | null;
  } | null;
  primaryGuardian: { nameBn: string | null; nameEn: string | null; phone: string } | null;
}

export interface StudentsPage {
  items: StudentListItem[];
  page: number;
  pageSize: number;
  /** Number of students matching the query (on every page). */
  total: number;
}

/** GET /students/summary (OWNER/ADMIN): the dashboard's student figures. */
export interface StudentsSummary {
  /** Today in the institute's timezone. */
  today: string;
  /** Students by status (removed records not counted). */
  byStatus: Record<StudentStatus, number>;
  /**
   * Active students enrolled in the current year, by class, in class order: every active class
   * (empty ones too), and an inactive class only while it still has active students.
   */
  byClass: { classLevel: { id: string; nameBn: string; nameEn: string }; count: number }[];
  /**
   * Student records added per month (admitted or imported; removed ones not counted), the last
   * 12 months in the institute's timezone, oldest first, this month last.
   */
  addedByMonth: { month: string; count: number }[];
}

/** GET /me/children — a guardian's own children in the selected institute. */
export interface GuardianChild {
  id: string;
  studentCode: string;
  nameBn: string | null;
  nameEn: string | null;
  photoUrl: string | null;
  status: StudentListItem['status'];
  relation:
    | 'FATHER'
    | 'MOTHER'
    | 'BROTHER'
    | 'SISTER'
    | 'GRANDFATHER'
    | 'GRANDMOTHER'
    | 'UNCLE'
    | 'AUNT'
    | 'OTHER';
  /** Enrolment in the current academic year. */
  enrolment: StudentListItem['enrolment'];
}

/** GET /students/filters — class levels with their sections in the current academic year. */
export interface StudentFilters {
  classLevels: {
    id: string;
    nameBn: string;
    nameEn: string;
    sections: { id: string; name: string }[];
  }[];
}

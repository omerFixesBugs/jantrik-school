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
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type StudentsQuery = z.input<typeof studentsQuerySchema>;

export interface StudentListItem {
  id: string;
  studentCode: string;
  nameBn: string | null;
  nameEn: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'GRADUATED' | 'TRANSFERRED' | 'DROPPED_OUT';
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
  nextCursor: string | null;
  /** Number of students matching the query; on the first page only (null with a cursor). */
  total: number | null;
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

import { z } from 'zod';
import { STUDENT_SORTS, STUDENT_STATUSES, STUDENTS_PAGE_SIZE } from './api.js';
import { toAsciiDigits } from './digits.js';
import { COLOR_SCHEMES, THEME_PRESETS } from './themes.js';

// The API's request schemas for api.ts's shapes, apart from it so the browser (which needs
// TENANT_HEADER on every request) never loads zod (see dates-schema.ts).

/** PUT /settings/appearance (OWNER). Null preset: back to the type's default; null accent: the
 * preset's own. The accent must read in both light and dark (shared fitAccent), else 422. */
export const appearanceSchema = z.object({
  preset: z.enum(THEME_PRESETS).nullable(),
  accent: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^#[0-9a-f]{6}$/, 'Expected #rrggbb')
    .nullable(),
});
export type AppearanceInput = z.infer<typeof appearanceSchema>;

/** PATCH /me/preferences: the language, the light/dark choice, or both. */
export const preferencesSchema = z
  .object({
    locale: z.enum(['bn', 'en']).optional(),
    colorScheme: z.enum(COLOR_SCHEMES).optional(),
  })
  .refine((p) => p.locale !== undefined || p.colorScheme !== undefined, {
    message: 'Nothing to change',
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
  status: z.enum(STUDENT_STATUSES).optional(),
  sort: z.enum(STUDENT_SORTS).default('code'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  /** For `sort=name`: Bangla names first (bn) or English names first (en). */
  locale: z.enum(['bn', 'en']).default('bn'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(STUDENTS_PAGE_SIZE),
});
export type StudentsQuery = z.input<typeof studentsQuerySchema>;

import { z } from 'zod';
import { IMPORT_FIELDS } from './import.js';

// The import API's request schemas, apart from import.ts so the browser can use its rules
// without loading zod (see dates-schema.ts).

export const importMappingSchema = z.object({
  mapping: z
    .record(z.enum(IMPORT_FIELDS), z.number().int().min(0).max(200).nullable())
    .refine((m) => {
      const cols = Object.values(m).filter((v): v is number => v !== null);
      return new Set(cols).size === cols.length;
    }, 'A column is mapped twice'),
});

export const importRowsQuerySchema = z.object({
  filter: z.enum(['all', 'ok', 'error', 'exists', 'duplicate']).default('all'),
  page: z.coerce.number().int().min(0).max(1000).default(0),
});

/** PUT /student-imports/:id/rows/:row/duplicate: import a possible duplicate anyway (or not). */
export const duplicateOverrideSchema = z.object({ import: z.boolean() });

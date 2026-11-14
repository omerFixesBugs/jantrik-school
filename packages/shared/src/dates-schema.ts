import { z } from 'zod';
import { ISO_DATE, isIsoDate } from './dates.js';

// Schemas live apart from the helpers they validate with, so the browser can use dates.ts without
// loading zod (docs/design.md → Performance budget; apps/web/src/lib/browser-imports.test.ts).

/** A real calendar date (rejects 2026-02-30). */
export const isoDateSchema = z
  .string()
  .regex(ISO_DATE, 'Expected YYYY-MM-DD')
  .refine(isIsoDate, 'Not a calendar date');

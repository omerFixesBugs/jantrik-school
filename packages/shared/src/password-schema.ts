import { z } from 'zod';
import { toAsciiDigits } from './digits.js';

// Zod schemas stay out of the browser (apps/web/src/lib/browser-imports.test.ts): the rules the
// form shows are in password.ts.

/**
 * `PUT /me/password`. The code accepts Bangla digits and surrounding spaces. The password is only
 * capped here (a hashing cost bound); its rules are `passwordProblems` plus the server's list.
 */
export const setPasswordSchema = z.object({
  code: z
    .string()
    .trim()
    .transform(toAsciiDigits)
    .pipe(z.string().regex(/^\d{6}$/, 'Code must be 6 digits')),
  password: z.string().max(512),
});
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;

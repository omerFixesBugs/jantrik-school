import { z } from 'zod';
import { normalizeBdPhone } from './phone.js';

// Apart from phone.ts, so the browser formats phones without loading zod (see dates-schema.ts).

/** zod schema: parses any accepted format and outputs E.164. */
export const bdPhoneSchema = z.string().transform((value, ctx) => {
  const phone = normalizeBdPhone(value);
  if (!phone) {
    ctx.addIssue({ code: 'custom', message: 'Invalid Bangladeshi mobile number' });
    return z.NEVER;
  }
  return phone;
});

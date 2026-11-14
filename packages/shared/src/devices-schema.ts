import { z } from 'zod';
import { DEVICE_USER_ID_RE } from './devices.js';
import { toAsciiDigits } from './digits.js';

// Apart from devices.ts, so the browser can use the device rules without loading zod (see
// dates-schema.ts).

export const deviceUserIdSchema = z
  .string()
  .transform((v) => toAsciiDigits(v).trim())
  .pipe(
    z.string().regex(DEVICE_USER_ID_RE, 'Device ID must be 3 to 9 digits, not starting with 0'),
  );

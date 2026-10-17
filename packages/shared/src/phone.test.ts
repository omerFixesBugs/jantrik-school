import { describe, expect, it } from 'vitest';
import { bdPhoneSchema, normalizeBdPhone } from './phone.js';

describe('normalizeBdPhone', () => {
  it.each(['01712345678', '8801712345678', '+8801712345678', '008801712345678', '017-1234 5678'])(
    'normalises %s',
    (input) => {
      expect(normalizeBdPhone(input)).toBe('+8801712345678');
    },
  );

  it.each(['0171234567', '01212345678', '+14155550100', '1712345678', 'abc'])(
    'rejects %s',
    (input) => {
      expect(normalizeBdPhone(input)).toBeNull();
    },
  );

  it('zod schema outputs E.164 or fails', () => {
    expect(bdPhoneSchema.parse('01812345678')).toBe('+8801812345678');
    expect(bdPhoneSchema.safeParse('12345').success).toBe(false);
  });
});

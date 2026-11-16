import { describe, expect, it } from 'vitest';
import {
  FILE_LIMITS,
  INSTITUTE_PROFILE_PATTERNS,
  normalizeInstitutePhone,
  normalizeWebsite,
  STORED_FILE_KINDS,
  UPLOAD_MAX_BYTES,
} from './files.js';
import { instituteProfileSchema } from './files-schema.js';

describe('file limits (docs/files.md, the stored_files CHECKs)', () => {
  it('has a limit for every kind, equal to the database caps', () => {
    expect(Object.keys(FILE_LIMITS).sort()).toEqual([...STORED_FILE_KINDS].sort());
    expect(FILE_LIMITS.STUDENT_PHOTO.maxBytes).toBe(204_800);
    expect(FILE_LIMITS.APPLICANT_PHOTO.maxBytes).toBe(204_800);
    expect(FILE_LIMITS.LOGO.maxBytes).toBe(102_400);
    expect(FILE_LIMITS.SEAL.maxBytes).toBe(102_400);
    expect(FILE_LIMITS.SIGNATURE.maxBytes).toBe(102_400);
    expect(FILE_LIMITS.DOCUMENT_ASSET.maxBytes).toBe(262_144);
    expect(FILE_LIMITS.STUDENT_PHOTO.mimes).toEqual(['image/jpeg']);
    expect(FILE_LIMITS.SIGNATURE.mimes).toEqual(['image/png']);
    expect(UPLOAD_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe('instituteProfileSchema', () => {
  const parse = (v: Record<string, unknown>) =>
    instituteProfileSchema.safeParse({ nameBn: 'শাপলা', ...v });

  it('trims, turns empty strings into null, and needs one name', () => {
    const r = instituteProfileSchema.parse({
      nameBn: '  শাপলা উচ্চ বিদ্যালয়  ',
      nameEn: '',
      eiin: '',
    });
    expect(r).toMatchObject({
      nameBn: 'শাপলা উচ্চ বিদ্যালয়',
      nameEn: null,
      eiin: null,
      phone: null,
    });
    expect(instituteProfileSchema.safeParse({ nameBn: ' ', nameEn: '' }).success).toBe(false);
  });

  it('accepts Bangla digits in the EIIN, the phone and the year', () => {
    const r = instituteProfileSchema.parse({
      nameEn: 'Shapla',
      eiin: '১০৮ ১২৩',
      phone: '০১৭১১-০০০০০০',
      establishedYear: '১৯৬৫',
    });
    expect(r).toMatchObject({ eiin: '108123', phone: '+8801711000000', establishedYear: 1965 });
  });

  it.each([
    ['01711000000', '+8801711000000'],
    ['+880 1711-000000', '+8801711000000'],
    ['02-9123456', '029123456'],
    ['(031) 712 345', '031712345'],
  ])('stores the phone %s as %s', (typed, stored) => {
    expect(normalizeInstitutePhone(typed)).toBe(stored);
    expect(parse({ phone: typed }).success).toBe(true);
  });

  it.each([
    ['a 5-digit EIIN', { eiin: '12345' }],
    ['letters in the EIIN', { eiin: '1081a3' }],
    ['a 4-digit phone', { phone: '1234' }],
    ['letters in the phone', { phone: 'call me' }],
    ['an e-mail without a domain', { email: 'office@' }],
    ['an ftp website', { website: 'ftp://shapla.edu.bd' }],
    ['year 1700', { establishedYear: 1700 }],
    ['year 2101', { establishedYear: '2101' }],
    ['a 31-character short name', { shortName: 'x'.repeat(31) }],
    ['a 201-character name', { nameBn: 'ক'.repeat(201) }],
  ])('refuses %s (as the database CHECK would)', (_name, v) => {
    expect(parse(v).success).toBe(false);
  });

  it('adds https:// to a bare website and keeps a given scheme', () => {
    expect(normalizeWebsite('shapla.edu.bd')).toBe('https://shapla.edu.bd');
    expect(normalizeWebsite('http://shapla.edu.bd')).toBe('http://shapla.edu.bd');
    expect(parse({ website: 'shapla.edu.bd' }).data?.website).toBe('https://shapla.edu.bd');
  });

  it('lower-cases the scheme, as the database CHECK is case-sensitive (review)', () => {
    expect(normalizeWebsite('Http://Shapla.edu.bd')).toBe('http://Shapla.edu.bd');
    expect(parse({ website: 'HTTPS://shapla.edu.bd' }).data?.website).toBe('https://shapla.edu.bd');
    expect(INSTITUTE_PROFILE_PATTERNS.website.test('HTTPS://shapla.edu.bd')).toBe(false);
  });
});

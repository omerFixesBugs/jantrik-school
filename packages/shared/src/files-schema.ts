import { z } from 'zod';
import { toAsciiDigits } from './digits.js';
import {
  INSTITUTE_PROFILE_LIMITS as L,
  INSTITUTE_PROFILE_PATTERNS as P,
  normalizeInstitutePhone,
  normalizeWebsite,
} from './files.js';

// PUT /institute/profile (sprint 1 P2). Each rule matches a CHECK on institute_profiles, so a
// value the schema accepts is never refused by the database.

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

/** Bangla digits and spaces accepted; empty → null. */
const digitsText = z
  .string()
  .nullish()
  .transform((v) => (v ? toAsciiDigits(v).replace(/\s/g, '') : '') || null);

export const instituteProfileSchema = z
  .object({
    nameBn: text(L.name),
    nameEn: text(L.name),
    shortName: text(L.shortName),
    eiin: digitsText.refine((v) => v === null || P.eiin.test(v), 'EIIN is 6 digits'),
    addressBn: text(L.address),
    addressEn: text(L.address),
    phone: z
      .string()
      .nullish()
      .transform((v) => (v?.trim() ? normalizeInstitutePhone(v) : null))
      .refine((v) => v === null || P.phone.test(v), 'A phone number of 5-15 digits'),
    email: text(L.email).refine((v) => v === null || P.email.test(v), 'An e-mail address'),
    website: z
      .string()
      .nullish()
      .transform((v) => (v?.trim() ? normalizeWebsite(v) : null))
      .refine(
        (v) => v === null || (v.length <= L.website && P.website.test(v)),
        'A web address (http or https)',
      ),
    headTitleBn: text(L.headTitle),
    headTitleEn: text(L.headTitle),
    headNameBn: text(L.headName),
    headNameEn: text(L.headName),
    establishedYear: z
      .union([z.number(), z.string()])
      .nullish()
      .transform((v) => {
        if (v === null || v === undefined) return null;
        const s = toAsciiDigits(String(v)).trim();
        return s === '' ? null : Number(s);
      })
      .refine(
        (v) => v === null || (Number.isInteger(v) && v >= L.yearMin && v <= L.yearMax),
        'A year between 1800 and 2100',
      ),
  })
  .refine((p) => p.nameBn !== null || p.nameEn !== null, {
    message: 'A name in Bangla or English is required',
    path: ['nameBn'],
  });

export type InstituteProfileInput = z.input<typeof instituteProfileSchema>;

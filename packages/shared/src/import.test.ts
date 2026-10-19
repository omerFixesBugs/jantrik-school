import { describe, expect, it } from 'vitest';
import {
  IMPORT_FIELDS,
  detectMapping,
  findInFileDuplicates,
  parseBloodGroup,
  parseImportDate,
  parseImportPhone,
  parseImportRow,
  templateHeader,
  type ImportLookups,
} from './import.js';

const lookups: ImportLookups = {
  classLevels: [
    { id: 'c6', code: 'CLASS_6', nameBn: 'ষষ্ঠ শ্রেণি', nameEn: 'Class 6', isActive: true },
    { id: 'c7', code: 'CLASS_7', nameBn: 'সপ্তম শ্রেণি', nameEn: 'Class 7', isActive: false },
  ],
  sections: [
    { id: 's6a', classLevelId: 'c6', name: 'ক', isActive: true },
    { id: 's6b', classLevelId: 'c6', name: 'খ', isActive: true },
  ],
  studyGroups: [
    { id: 'sci', code: 'SCIENCE', nameBn: 'বিজ্ঞান', nameEn: 'Science', isActive: true },
  ],
};

describe('header detection', () => {
  it('recognises the template, Bangla, English and common spellings', () => {
    const m = detectMapping([
      templateHeader('nameBn'),
      'Name',
      'শ্রেণি',
      'Section',
      'রোল নম্বর',
      'Mobile',
      'জন্ম নিবন্ধন নম্বর',
      'Something else',
    ]);
    expect(m).toMatchObject({
      nameBn: 0,
      nameEn: 1,
      classLevel: 2,
      section: 3,
      roll: 4,
      guardianPhone: 5,
      birthRegistrationNo: 6,
      dateOfBirth: null,
    });
  });

  it('every field has a distinct template header that maps back to itself', () => {
    const headers = IMPORT_FIELDS.map(templateHeader);
    const m = detectMapping(headers);
    IMPORT_FIELDS.forEach((f, i) => expect(m[f]).toBe(i));
  });
});

describe('cells', () => {
  it('phones: Bangla digits, +880, and Excel dropping the leading 0', () => {
    expect(parseImportPhone('০১৭১১০০০১০১')).toBe('+8801711000101');
    expect(parseImportPhone('1711000101')).toBe('+8801711000101');
    expect(parseImportPhone('+880 1711-000101')).toBe('+8801711000101');
    expect(parseImportPhone('12345')).toBeNull();
  });

  it('dates: ISO, day-first, Bangla digits; nothing in the future', () => {
    expect(parseImportDate('2013-05-17')).toBe('2013-05-17');
    expect(parseImportDate('17/05/2013')).toBe('2013-05-17');
    expect(parseImportDate('১৭-০৫-২০১৩')).toBe('2013-05-17');
    expect(parseImportDate('31/02/2013')).toBeNull();
    expect(parseImportDate('01/01/2999')).toBeNull();
  });

  it('blood groups', () => {
    expect(parseBloodGroup('B+')).toBe('B_POSITIVE');
    expect(parseBloodGroup('ab -')).toBe('AB_NEGATIVE');
    expect(parseBloodGroup('O Positive')).toBe('O_POSITIVE');
    expect(parseBloodGroup('X')).toBeNull();
  });
});

describe('rows', () => {
  const headers = ['নাম', 'Class', 'Section', 'Roll', 'Phone', 'Relation', 'Gender', 'Birth reg'];
  const mapping = detectMapping(headers);

  it('a good row: Bangla digits, class by Bangla name, section, relation word', () => {
    const r = parseImportRow(
      ['তাসনিম', 'ষষ্ঠ শ্রেণি', 'ক', '১২', '01711000101', 'মা', 'মেয়ে', '২০১৩১২৩৪৫৬৭৮৯০১২৩'],
      mapping,
      lookups,
    );
    expect(r).toMatchObject({
      ok: true,
      student: {
        nameBn: 'তাসনিম',
        classLevelId: 'c6',
        sectionId: 's6a',
        roll: 12,
        gender: 'FEMALE',
        birthRegistrationNo: '20131234567890123',
        guardians: [{ phone: '+8801711000101', relation: 'MOTHER', isPrimary: true }],
      },
    });
  });

  it('reports every problem with its field', () => {
    const r = parseImportRow(
      ['', 'Class 7', 'Z', 'abc', '123', 'cousin', 'x', '123'],
      mapping,
      lookups,
    );
    expect(r.ok).toBe(false);
    const codes = r.ok ? [] : r.errors.map((e) => e.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'NAME_MISSING',
        'CLASS_UNKNOWN', // inactive class levels cannot be imported into
        'ROLL_INVALID',
        'PHONE_INVALID',
        'RELATION_UNKNOWN',
        'GENDER_UNKNOWN',
        'BIRTH_REG_INVALID',
      ]),
    );
  });

  it('class by "6" or code; unknown section; missing phone', () => {
    const r = parseImportRow(['Rafi', '6', 'গ', '', '', '', '', ''], mapping, lookups);
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toEqual(['SECTION_UNKNOWN', 'PHONE_MISSING']);
  });

  it('duplicates inside the file: roll in a section, birth registration', () => {
    const row = (roll: string, reg: string) =>
      parseImportRow(['A', 'Class 6', 'ক', roll, '01711000101', '', '', reg], mapping, lookups);
    const dups = findInFileDuplicates([
      row('1', '20131234567890123'),
      row('1', '20131234567890124'),
      row('2', '20131234567890123'),
    ]);
    expect(dups.get(0)).toBeUndefined();
    expect(dups.get(1)?.map((e) => e.code)).toEqual(['ROLL_DUPLICATE_IN_FILE']);
    expect(dups.get(2)?.map((e) => e.code)).toEqual(['BIRTH_REG_DUPLICATE_IN_FILE']);
  });
});

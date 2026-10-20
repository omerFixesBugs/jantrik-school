import { describe, expect, it } from 'vitest';
import { STUDENTS_PAGE_SIZE, studentsQuerySchema } from './api.js';
import {
  admissionSchema,
  defaultCodePrefix,
  normalizeBirthRegistration,
  renderStudentCode,
  studentSettingsSchema,
  validateCodePattern,
} from './students.js';

const base = {
  nameBn: 'তাসনিম',
  guardians: [{ phone: '01711000101', relation: 'FATHER', isPrimary: true, nameBn: 'বাবা' }],
  enrolment: {
    academicYearId: '0190a000-0000-7000-8000-000000000001',
    classLevelId: '0190a000-0000-7000-8000-000000000002',
  },
} as const;

describe('student codes', () => {
  it('renders patterns', () => {
    expect(renderStudentCode('{PREFIX}-{YEAR}-{NNNN}', { prefix: 'SS', year: 2026, seq: 7 })).toBe(
      'SS-2026-0007',
    );
    expect(renderStudentCode('{YY}{NNN}', { prefix: 'X', year: 2026, seq: 12345 })).toBe('2612345');
  });

  it('validates patterns', () => {
    expect(validateCodePattern('{PREFIX}-{YEAR}-{NNNN}')).toEqual([]);
    expect(validateCodePattern('{PREFIX}-{YEAR}')).not.toEqual([]); // no number
    expect(validateCodePattern('{NN}-{NN}')).not.toEqual([]); // two numbers
    expect(validateCodePattern('{NAME}-{NNN}')).not.toEqual([]); // unknown token
    expect(validateCodePattern('ab {NNN}')).not.toEqual([]); // lowercase, space
  });

  it('default prefix from the slug', () => {
    expect(defaultCodePrefix('shapla-school')).toBe('SS');
    expect(defaultCodePrefix('alo')).toBe('STU');
  });

  it('settings: prefix uppercased, pattern checked', () => {
    expect(
      studentSettingsSchema.parse({ codePrefix: 'shs', codePattern: '{PREFIX}-{NNNN}' }),
    ).toEqual({
      codePrefix: 'SHS',
      codePattern: '{PREFIX}-{NNNN}',
    });
    expect(
      studentSettingsSchema.safeParse({ codePrefix: 'SHS', codePattern: '{PREFIX}' }).success,
    ).toBe(false);
  });
});

describe('admission', () => {
  it('17-digit birth registration with Bangla digits, spaces and dashes', () => {
    expect(normalizeBirthRegistration('২০১২ ৩৪৫৬-৭৮৯০১২৩৪৫')).toBe('20123456789012345');
    expect(normalizeBirthRegistration('1234')).toBeNull();
  });

  it('accepts a minimal admission and normalises the guardian phone', () => {
    const a = admissionSchema.parse(base);
    expect(a.guardians[0]!.phone).toBe('+8801711000101');
    expect(a.studentCode).toBeNull();
    expect(a.enrolment.roll).toBeNull();
  });

  it('needs a name, one primary guardian, distinct phones, a valid phone', () => {
    expect(admissionSchema.safeParse({ ...base, nameBn: '' }).success).toBe(false);
    expect(
      admissionSchema.safeParse({
        ...base,
        guardians: [{ ...base.guardians[0], isPrimary: false }],
      }).success,
    ).toBe(false);
    expect(
      admissionSchema.safeParse({
        ...base,
        guardians: [base.guardians[0], { ...base.guardians[0], isPrimary: false }],
      }).success,
    ).toBe(false);
    expect(
      admissionSchema.safeParse({ ...base, guardians: [{ ...base.guardians[0], phone: '12345' }] })
        .success,
    ).toBe(false);
  });

  it('roll and date of birth accept Bangla digits', () => {
    const a = admissionSchema.parse({
      ...base,
      dateOfBirth: '২০১৩-০৫-১৭',
      enrolment: { ...base.enrolment, roll: '১২' },
    });
    expect(a.dateOfBirth).toBe('2013-05-17');
    expect(a.enrolment.roll).toBe(12);
    expect(admissionSchema.safeParse({ ...base, dateOfBirth: '2999-01-01' }).success).toBe(false);
  });
});

describe('studentsQuerySchema (GET /students)', () => {
  it('pages of 50 by code by default; Bangla digits in the search become ASCII', () => {
    expect(studentsQuerySchema.parse({ q: 'A-০০৩' })).toEqual({
      q: 'A-003',
      sort: 'code',
      dir: 'asc',
      locale: 'bn',
      page: 1,
      pageSize: STUDENTS_PAGE_SIZE,
    });
    expect(STUDENTS_PAGE_SIZE).toBe(50);
  });

  it('sort, direction, status and page come from the URL as text', () => {
    expect(
      studentsQuerySchema.parse({
        sort: 'roll',
        dir: 'desc',
        status: 'INACTIVE',
        page: '3',
        pageSize: '100',
      }),
    ).toMatchObject({ sort: 'roll', dir: 'desc', status: 'INACTIVE', page: 3, pageSize: 100 });
  });

  it.each([{ pageSize: '101' }, { page: '0' }, { sort: 'phone' }, { status: 'DELETED' }])(
    'rejects %o',
    (q) => expect(studentsQuerySchema.safeParse(q).success).toBe(false),
  );
});

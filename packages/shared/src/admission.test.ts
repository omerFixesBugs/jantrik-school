import { describe, expect, it } from 'vitest';
import {
  applicationNameKey,
  approvableStatuses,
  effectiveAdmissionFields,
  formatApplicationNo,
  hiddenAdmissionFieldsGiven,
  missingAdmissionFields,
  nameKey,
  type AdmissionApplicationFields,
} from './admission.js';
import {
  admissionApplicationFieldsSchema,
  admissionApplicationsQuerySchema,
  admissionCycleClassesSchema,
  admissionCycleSchema,
  admissionStatusSchema,
  approveAdmissionSchema,
  staffAdmissionApplicationSchema,
  updateAdmissionCycleSchema,
} from './admission-schema.js';

const bn = (s: string) => s.replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!);

const payload = (over: Record<string, unknown> = {}) => ({
  nameBn: 'রাফি আহমেদ',
  dateOfBirth: '2019-05-01',
  gender: 'MALE',
  guardianNameBn: 'করিম আহমেদ',
  guardianRelation: 'FATHER',
  ...over,
});

describe('admission: names and numbers', () => {
  it('nameKey ignores spaces and case', () => {
    expect(nameKey('  Rahim  Uddin ')).toBe(nameKey('rahimuddin'));
    expect(nameKey('RAHIM UDDIN')).toBe('rahimuddin');
    // NFC: a decomposed Bangla vowel sign matches the composed one.
    expect(nameKey('কো')).toBe(nameKey('কো'.normalize('NFD')));
    expect(applicationNameKey({ nameBn: null, nameEn: 'Rafi Ahmed' })).toBe('rafiahmed');
    expect(applicationNameKey({ nameBn: 'রাফি আহমেদ', nameEn: 'Rafi' })).toBe('রাফিআহমেদ');
  });

  it('application numbers: four digits, more past 9999', () => {
    expect(formatApplicationNo(2027, 1)).toBe('2027-0001');
    expect(formatApplicationNo(2027, 10000)).toBe('2027-10000');
  });

  it('which statuses may be approved (P3-H)', () => {
    expect(approvableStatuses(false)).toEqual(['SUBMITTED', 'SHORTLISTED', 'SELECTED']);
    expect(approvableStatuses(true)).toEqual(['SELECTED']);
  });
});

describe('admission: the form fields', () => {
  const fields = (a: Partial<AdmissionApplicationFields> = {}): AdmissionApplicationFields => ({
    nameBn: 'রাফি',
    nameEn: null,
    dateOfBirth: '2019-05-01',
    gender: 'MALE',
    religion: null,
    bloodGroup: null,
    birthRegistrationNo: null,
    previousInstitute: null,
    presentAddress: null,
    permanentAddress: null,
    fatherNameBn: null,
    fatherNameEn: null,
    motherNameBn: null,
    motherNameEn: null,
    guardianNameBn: 'করিম',
    guardianNameEn: null,
    guardianRelation: 'FATHER',
    guardianOccupation: null,
    ...a,
  });

  it('defaults: optional fields, blood group hidden, the photo only when collected', () => {
    const d = effectiveAdmissionFields({}, false);
    expect(d.religion).toBe('OPTIONAL');
    expect(d.blood_group).toBe('HIDDEN');
    expect(d.photo).toBe('HIDDEN');
    expect(effectiveAdmissionFields({}, true).photo).toBe('OPTIONAL');
    expect(effectiveAdmissionFields({ photo: 'REQUIRED' }, true).photo).toBe('REQUIRED');
    expect(effectiveAdmissionFields({ photo: 'REQUIRED' }, false).photo).toBe('HIDDEN');
    expect(effectiveAdmissionFields({ father_name: 'REQUIRED', bogus: 'X' }, false)).toMatchObject({
      father_name: 'REQUIRED',
    });
  });

  it('required fields left empty, hidden fields given', () => {
    const s = effectiveAdmissionFields(
      { father_name: 'REQUIRED', photo: 'REQUIRED', blood_group: 'HIDDEN' },
      true,
    );
    expect(missingAdmissionFields(s, fields(), false)).toEqual(['photo', 'father_name']);
    expect(missingAdmissionFields(s, fields({ fatherNameEn: 'Karim' }), true)).toEqual([]);
    expect(hiddenAdmissionFieldsGiven(s, fields({ bloodGroup: 'A_POSITIVE' }), false)).toEqual([
      'blood_group',
    ]);
  });
});

describe('admission: input schemas', () => {
  it('the public payload: Bangla digits accepted, unknown keys refused, names required', () => {
    const r = admissionApplicationFieldsSchema.parse(
      payload({ dateOfBirth: bn('2019-05-01'), birthRegistrationNo: bn('20191234567890123') }),
    );
    expect(r.dateOfBirth).toBe('2019-05-01');
    expect(r.birthRegistrationNo).toBe('20191234567890123');
    expect(r.religion).toBeNull();
    expect(
      admissionApplicationFieldsSchema.safeParse(payload({ phone: '01711000000' })).success,
    ).toBe(false);
    expect(admissionApplicationFieldsSchema.safeParse(payload({ nameBn: '' })).success).toBe(false);
    expect(
      admissionApplicationFieldsSchema.safeParse(payload({ guardianNameBn: ' ' })).success,
    ).toBe(false);
    expect(
      admissionApplicationFieldsSchema.safeParse(
        payload({ birthRegistrationNo: '2019123456789012' }),
      ).success,
    ).toBe(false);
  });

  it('a staff entry: the phone typed in Bangla digits becomes E.164', () => {
    const r = staffAdmissionApplicationSchema.parse({
      ...payload(),
      cycleClassId: '01900000-0000-7000-8000-000000000001',
      phone: bn('01711-000000'),
    });
    expect(r.phone).toBe('+8801711000000');
    expect(r.staffNote).toBeNull();
  });

  it('a status change: a reason for REJECTED and WITHDRAWN', () => {
    expect(admissionStatusSchema.safeParse({ status: 'REJECTED' }).success).toBe(false);
    expect(
      admissionStatusSchema.safeParse({ status: 'REJECTED', reason: 'Too young' }).success,
    ).toBe(true);
    expect(admissionStatusSchema.safeParse({ status: 'SHORTLISTED' }).success).toBe(true);
    // ADMITTED is never set by hand (approval sets it).
    expect(admissionStatusSchema.safeParse({ status: 'ADMITTED' }).success).toBe(false);
  });

  it('approve: a roll in Bangla digits; not both an existing and a new guardian', () => {
    expect(approveAdmissionSchema.parse({ roll: bn('41') }).roll).toBe(41);
    expect(
      approveAdmissionSchema.safeParse({
        guardianId: '01900000-0000-7000-8000-000000000001',
        createNew: true,
      }).success,
    ).toBe(false);
  });

  it('a cycle: the window, the fields', () => {
    const base = {
      academicYearId: '01900000-0000-7000-8000-000000000001',
      nameBn: 'ভর্তি ২০২৭',
      opensAt: '2026-11-01T00:00:00+06:00',
      closesAt: '2026-12-31T23:59:00+06:00',
    };
    expect(admissionCycleSchema.parse(base).fields).toEqual({});
    expect(
      admissionCycleSchema.safeParse({ ...base, closesAt: '2026-10-01T00:00:00+06:00' }).success,
    ).toBe(false);
    expect(
      admissionCycleSchema.safeParse({ ...base, fields: { colour: 'REQUIRED' } }).success,
    ).toBe(false);
    expect(admissionCycleSchema.safeParse({ ...base, fields: { religion: 'YES' } }).success).toBe(
      false,
    );
    expect(updateAdmissionCycleSchema.safeParse({ status: 'OPEN' }).success).toBe(false);
  });

  it('the class list: each class and group once; seats typed in Bangla digits', () => {
    const c = '01900000-0000-7000-8000-000000000001';
    expect(
      admissionCycleClassesSchema.parse({ classes: [{ classLevelId: c, seats: bn('40') }] })
        .classes[0]!.seats,
    ).toBe(40);
    expect(
      admissionCycleClassesSchema.safeParse({
        classes: [{ classLevelId: c }, { classLevelId: c, studyGroupId: null }],
      }).success,
    ).toBe(false);
  });

  it('the list query: paging defaults', () => {
    expect(admissionApplicationsQuerySchema.parse({})).toMatchObject({ page: 1, pageSize: 50 });
    expect(admissionApplicationsQuerySchema.parse({ q: '  ' }).q).toBeUndefined();
  });
});

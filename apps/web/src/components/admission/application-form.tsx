'use client';

import {
  BLOOD_GROUP_LABEL,
  BLOOD_GROUPS,
  GENDERS,
  GUARDIAN_RELATIONS,
  RELIGIONS,
  type AdmissionApplicationDetail,
  type AdmissionFieldSettings,
} from '@jantrik/shared';
import { useTranslations } from 'next-intl';
import { SectionCard, SelectField, TextField } from '@/components/form-kit';
import { FormGrid } from '@/components/form-layout';
import { ApiError } from '@/lib/api/errors';

/** What the staff form edits (strings as typed; the API validates and normalises). */
export interface ApplicationValues {
  nameBn: string;
  nameEn: string;
  dateOfBirth: string;
  gender: string;
  religion: string;
  bloodGroup: string;
  birthRegistrationNo: string;
  previousInstitute: string;
  presentAddress: string;
  permanentAddress: string;
  fatherNameBn: string;
  fatherNameEn: string;
  motherNameBn: string;
  motherNameEn: string;
  guardianNameBn: string;
  guardianNameEn: string;
  guardianRelation: string;
  guardianOccupation: string;
  phone: string;
  staffNote: string;
}

export const emptyApplication: ApplicationValues = {
  nameBn: '',
  nameEn: '',
  dateOfBirth: '',
  gender: '',
  religion: '',
  bloodGroup: '',
  birthRegistrationNo: '',
  previousInstitute: '',
  presentAddress: '',
  permanentAddress: '',
  fatherNameBn: '',
  fatherNameEn: '',
  motherNameBn: '',
  motherNameEn: '',
  guardianNameBn: '',
  guardianNameEn: '',
  guardianRelation: 'FATHER',
  guardianOccupation: '',
  phone: '',
  staffNote: '',
};

/** The form's values from a stored application. */
export function valuesFrom(a: AdmissionApplicationDetail): ApplicationValues {
  const s = (v: string | null) => v ?? '';
  return {
    nameBn: s(a.nameBn),
    nameEn: s(a.nameEn),
    dateOfBirth: a.dateOfBirth,
    gender: a.gender,
    religion: s(a.religion),
    bloodGroup: s(a.bloodGroup),
    birthRegistrationNo: s(a.birthRegistrationNo),
    previousInstitute: s(a.previousInstitute),
    presentAddress: s(a.presentAddress),
    permanentAddress: s(a.permanentAddress),
    fatherNameBn: s(a.fatherNameBn),
    fatherNameEn: s(a.fatherNameEn),
    motherNameBn: s(a.motherNameBn),
    motherNameEn: s(a.motherNameEn),
    guardianNameBn: s(a.guardianNameBn),
    guardianNameEn: s(a.guardianNameEn),
    guardianRelation: a.guardianRelation,
    guardianOccupation: s(a.guardianOccupation),
    phone: a.phone.replace(/^\+880/, '0'),
    staffNote: s(a.staffNote),
  };
}

/** The JSON the API takes (empty text → null; the API trims and checks). */
export function applicationPayload(v: ApplicationValues) {
  const n = (x: string) => (x.trim() === '' ? null : x);
  return {
    nameBn: n(v.nameBn),
    nameEn: n(v.nameEn),
    dateOfBirth: v.dateOfBirth,
    gender: v.gender,
    religion: n(v.religion),
    bloodGroup: n(v.bloodGroup),
    birthRegistrationNo: n(v.birthRegistrationNo),
    previousInstitute: n(v.previousInstitute),
    presentAddress: n(v.presentAddress),
    permanentAddress: n(v.permanentAddress),
    fatherNameBn: n(v.fatherNameBn),
    fatherNameEn: n(v.fatherNameEn),
    motherNameBn: n(v.motherNameBn),
    motherNameEn: n(v.motherNameEn),
    guardianNameBn: n(v.guardianNameBn),
    guardianNameEn: n(v.guardianNameEn),
    guardianRelation: v.guardianRelation,
    guardianOccupation: n(v.guardianOccupation),
    phone: v.phone,
    staffNote: n(v.staffNote),
  };
}

/** Problems the form can see before sending (the always-required fields). */
export function localProblems(v: ApplicationValues, required: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v.nameBn.trim() && !v.nameEn.trim()) out['nameBn'] = required;
  if (!v.dateOfBirth) out['dateOfBirth'] = required;
  if (!v.gender) out['gender'] = required;
  if (!v.guardianNameBn.trim() && !v.guardianNameEn.trim()) out['guardianNameBn'] = required;
  if (!v.phone.trim()) out['phone'] = required;
  return out;
}

/** Field errors from a 400 (zod paths) or 422 ADMISSION_FIELDS_REQUIRED, as the form's keys. */
export function serverProblems(
  error: unknown,
  invalid: string,
  required: string,
): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const body = error.body as {
    errors?: { path: string }[];
    fields?: string[];
    field?: string;
  } | null;
  const out: Record<string, string> = {};
  for (const e of body?.errors ?? []) out[e.path.split('.')[0] ?? e.path] = invalid;
  const key: Record<string, string> = {
    religion: 'religion',
    blood_group: 'bloodGroup',
    birth_registration_no: 'birthRegistrationNo',
    previous_institute: 'previousInstitute',
    present_address: 'presentAddress',
    permanent_address: 'permanentAddress',
    father_name: 'fatherNameBn',
    mother_name: 'motherNameBn',
    guardian_occupation: 'guardianOccupation',
  };
  for (const f of body?.fields ?? []) if (key[f]) out[key[f]] = required;
  if (body?.field) out[body.field] = out[body.field] ?? invalid;
  return out;
}

/**
 * The application's fields in three cards: the child, the guardian, more details. `settings`
 * marks the cycle's required fields (staff may fill any field).
 */
export function ApplicationFields({
  values,
  onChange,
  errors,
  settings,
  showNote = true,
}: {
  values: ApplicationValues;
  onChange: (v: ApplicationValues) => void;
  errors: Record<string, string>;
  settings: AdmissionFieldSettings | null;
  showNote?: boolean;
}) {
  const t = useTranslations('admission');
  const tf = useTranslations('admissions.staff.form');
  const td = useTranslations('admissions.staff.detail');
  const te = useTranslations('enums');
  const set = (k: keyof ApplicationValues) => (v: string) => onChange({ ...values, [k]: v });
  const req = (f: keyof AdmissionFieldSettings) => settings?.[f] === 'REQUIRED';

  return (
    <div className="flex flex-col gap-5">
      <SectionCard id="application-child" title={tf('child')}>
        <FormGrid>
          <TextField
            id="nameBn"
            label={t('nameBn')}
            value={values.nameBn}
            onChange={set('nameBn')}
            error={errors['nameBn']}
            required
          />
          <TextField
            id="nameEn"
            label={t('nameEn')}
            value={values.nameEn}
            onChange={set('nameEn')}
            error={errors['nameEn']}
          />
          <TextField
            id="dateOfBirth"
            type="date"
            label={t('dateOfBirth')}
            value={values.dateOfBirth}
            onChange={set('dateOfBirth')}
            error={errors['dateOfBirth']}
            required
          />
          <SelectField
            id="gender"
            label={t('gender')}
            value={values.gender}
            onChange={set('gender')}
            placeholder={t('choose')}
            options={GENDERS.map((g) => ({ value: g, label: te(`gender_${g}`) }))}
            error={errors['gender']}
            required
          />
          <TextField
            id="birthRegistrationNo"
            label={t('birthReg')}
            value={values.birthRegistrationNo}
            onChange={set('birthRegistrationNo')}
            hint={t('birthRegHint')}
            inputMode="numeric"
            error={errors['birthRegistrationNo']}
            required={req('birth_registration_no')}
          />
          <SelectField
            id="religion"
            label={t('religion')}
            value={values.religion}
            onChange={set('religion')}
            placeholder={t('none')}
            options={RELIGIONS.map((r) => ({ value: r, label: te(`religion_${r}`) }))}
            error={errors['religion']}
            required={req('religion')}
          />
          <SelectField
            id="bloodGroup"
            label={t('bloodGroup')}
            value={values.bloodGroup}
            onChange={set('bloodGroup')}
            placeholder={t('none')}
            options={BLOOD_GROUPS.map((b) => ({ value: b, label: BLOOD_GROUP_LABEL[b] }))}
            error={errors['bloodGroup']}
            required={req('blood_group')}
          />
        </FormGrid>
      </SectionCard>

      <SectionCard id="application-guardian" title={tf('guardian')}>
        <FormGrid>
          <TextField
            id="guardianNameBn"
            label={tf('guardianNameBn')}
            value={values.guardianNameBn}
            onChange={set('guardianNameBn')}
            error={errors['guardianNameBn']}
            required
          />
          <TextField
            id="guardianNameEn"
            label={tf('guardianNameEn')}
            value={values.guardianNameEn}
            onChange={set('guardianNameEn')}
            error={errors['guardianNameEn']}
          />
          <SelectField
            id="guardianRelation"
            label={t('relation')}
            value={values.guardianRelation}
            onChange={set('guardianRelation')}
            options={GUARDIAN_RELATIONS.map((r) => ({ value: r, label: te(`relation_${r}`) }))}
            error={errors['guardianRelation']}
            required
          />
          <TextField
            id="phone"
            label={t('phone')}
            value={values.phone}
            onChange={set('phone')}
            hint={t('phoneHint')}
            inputMode="tel"
            autoComplete="off"
            error={errors['phone']}
            required
          />
          <TextField
            id="guardianOccupation"
            label={t('occupation')}
            value={values.guardianOccupation}
            onChange={set('guardianOccupation')}
            error={errors['guardianOccupation']}
            required={req('guardian_occupation')}
          />
        </FormGrid>
      </SectionCard>

      <SectionCard id="application-more" title={tf('more')}>
        <FormGrid>
          <TextField
            id="fatherNameBn"
            label={t('fatherNameBn')}
            value={values.fatherNameBn}
            onChange={set('fatherNameBn')}
            error={errors['fatherNameBn']}
            required={req('father_name')}
          />
          <TextField
            id="fatherNameEn"
            label={t('fatherNameEn')}
            value={values.fatherNameEn}
            onChange={set('fatherNameEn')}
            error={errors['fatherNameEn']}
          />
          <TextField
            id="motherNameBn"
            label={t('motherNameBn')}
            value={values.motherNameBn}
            onChange={set('motherNameBn')}
            error={errors['motherNameBn']}
            required={req('mother_name')}
          />
          <TextField
            id="motherNameEn"
            label={t('motherNameEn')}
            value={values.motherNameEn}
            onChange={set('motherNameEn')}
            error={errors['motherNameEn']}
          />
          <TextField
            id="previousInstitute"
            label={tf('previousInstitute')}
            value={values.previousInstitute}
            onChange={set('previousInstitute')}
            error={errors['previousInstitute']}
            required={req('previous_institute')}
          />
          <TextField
            id="presentAddress"
            label={t('presentAddress')}
            value={values.presentAddress}
            onChange={set('presentAddress')}
            error={errors['presentAddress']}
            required={req('present_address')}
            className="md:col-span-2"
          />
          <TextField
            id="permanentAddress"
            label={t('permanentAddress')}
            value={values.permanentAddress}
            onChange={set('permanentAddress')}
            error={errors['permanentAddress']}
            required={req('permanent_address')}
            className="md:col-span-2"
          />
          {showNote && (
            <TextField
              id="staffNote"
              label={td('staffNote')}
              value={values.staffNote}
              onChange={set('staffNote')}
              error={errors['staffNote']}
              className="md:col-span-2 xl:col-span-3"
            />
          )}
        </FormGrid>
      </SectionCard>
    </div>
  );
}

'use client';

import {
  BLOOD_GROUPS,
  BLOOD_GROUP_LABEL,
  GENDERS,
  GUARDIAN_RELATIONS,
  RELIGIONS,
  normalizeBdPhone,
  normalizeBirthRegistration,
  type GuardianRelation,
  type StudentProfile,
} from '@jantrik/shared';
import { PlusIcon, StarIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { SelectField, TextField, ToggleField } from '@/components/form-kit';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/errors';
import { cn } from '@/lib/utils';

/** The student's own fields as the form holds them (strings; '' = empty). */
export interface StudentFormValues {
  nameBn: string;
  nameEn: string;
  dateOfBirth: string;
  gender: string;
  religion: string;
  bloodGroup: string;
  birthRegistrationNo: string;
  fatherNameBn: string;
  fatherNameEn: string;
  motherNameBn: string;
  motherNameEn: string;
  presentAddress: string;
  permanentAddress: string;
}

export interface GuardianFormValues {
  key: string;
  phone: string;
  nameBn: string;
  nameEn: string;
  relation: GuardianRelation;
  occupation: string;
  isPrimary: boolean;
}

export const emptyStudent = (): StudentFormValues => ({
  nameBn: '',
  nameEn: '',
  dateOfBirth: '',
  gender: '',
  religion: '',
  bloodGroup: '',
  birthRegistrationNo: '',
  fatherNameBn: '',
  fatherNameEn: '',
  motherNameBn: '',
  motherNameEn: '',
  presentAddress: '',
  permanentAddress: '',
});

export const studentFromProfile = (p: StudentProfile): StudentFormValues => ({
  nameBn: p.nameBn ?? '',
  nameEn: p.nameEn ?? '',
  dateOfBirth: p.dateOfBirth ?? '',
  gender: p.gender ?? '',
  religion: p.religion ?? '',
  bloodGroup: p.bloodGroup ?? '',
  birthRegistrationNo: p.birthRegistrationNo ?? '',
  fatherNameBn: p.fatherNameBn ?? '',
  fatherNameEn: p.fatherNameEn ?? '',
  motherNameBn: p.motherNameBn ?? '',
  motherNameEn: p.motherNameEn ?? '',
  presentAddress: p.presentAddress ?? '',
  permanentAddress: p.permanentAddress ?? '',
});

/** The API body for the student's fields ('' → null). */
export const studentPayload = (v: StudentFormValues) => {
  const n = (s: string) => (s.trim() ? s.trim() : null);
  return {
    nameBn: n(v.nameBn),
    nameEn: n(v.nameEn),
    dateOfBirth: n(v.dateOfBirth),
    gender: n(v.gender),
    religion: n(v.religion),
    bloodGroup: n(v.bloodGroup),
    birthRegistrationNo: n(v.birthRegistrationNo),
    fatherNameBn: n(v.fatherNameBn),
    fatherNameEn: n(v.fatherNameEn),
    motherNameBn: n(v.motherNameBn),
    motherNameEn: n(v.motherNameEn),
    presentAddress: n(v.presentAddress),
    permanentAddress: n(v.permanentAddress),
  };
};

let guardianKey = 0;
export const newGuardian = (isPrimary: boolean, relation: GuardianRelation = 'FATHER') => ({
  key: `g${++guardianKey}`,
  phone: '',
  nameBn: '',
  nameEn: '',
  relation,
  occupation: '',
  isPrimary,
});

/** Problems we can see before sending (the API checks everything again). */
export function useStudentProblems() {
  const t = useTranslations('admission');
  return (v: StudentFormValues): Record<string, string> => {
    const p: Record<string, string> = {};
    if (!v.nameBn.trim() && !v.nameEn.trim()) p['nameBn'] = t('errorName');
    if (v.birthRegistrationNo.trim() && !normalizeBirthRegistration(v.birthRegistrationNo))
      p['birthRegistrationNo'] = t('errorBirthReg');
    return p;
  };
}

export function useGuardianProblems() {
  const t = useTranslations('admission');
  return (g: GuardianFormValues): Record<string, string> => {
    const p: Record<string, string> = {};
    if (!normalizeBdPhone(g.phone)) p['phone'] = t('errorPhone');
    return p;
  };
}

/** Field errors from the API (zod paths, or `field` on 409/422), keyed by our field names. */
export function useServerFieldErrors() {
  const t = useTranslations('admission');
  return (error: unknown): Record<string, string> => {
    if (!(error instanceof ApiError)) return {};
    const body = error.body as {
      errors?: { path: string }[];
      field?: string;
      code?: string;
    } | null;
    const out: Record<string, string> = {};
    for (const e of body?.errors ?? []) out[e.path] = t('errorInvalid');
    if (body?.field) {
      const known: Record<string, string> = {
        ROLL_TAKEN: t('errorRollTaken'),
        DUPLICATE:
          body.field === 'birthRegistrationNo' ? t('errorBirthRegTaken') : t('errorCodeTaken'),
        SECTION_FULL: t('errorSectionFull'),
        ROLL_NEEDS_SECTION: t('errorRollNeedsSection'),
        GUARDIAN_NAME_REQUIRED: t('errorGuardianName'),
        ALREADY_LINKED: t('errorAlreadyLinked'),
      };
      out[body.field] = known[body.code ?? ''] ?? t('errorInvalid');
    }
    return out;
  };
}

export function StudentFields({
  value,
  onChange,
  errors,
  idPrefix = 'st',
}: {
  value: StudentFormValues;
  onChange: (v: StudentFormValues) => void;
  errors: Record<string, string | undefined>;
  idPrefix?: string;
}) {
  const t = useTranslations('admission');
  const tEnum = useTranslations('enums');
  const set = (k: keyof StudentFormValues) => (v: string) => onChange({ ...value, [k]: v });
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id={id('name-bn')}
          label={t('nameBn')}
          value={value.nameBn}
          onChange={set('nameBn')}
          lang="bn"
          maxLength={120}
          error={errors['nameBn']}
        />
        <TextField
          id={id('name-en')}
          label={t('nameEn')}
          value={value.nameEn}
          onChange={set('nameEn')}
          lang="en"
          maxLength={120}
          error={errors['nameEn']}
        />
      </div>
      <p className="text-muted-foreground -mt-2 text-sm">{t('nameHint')}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          id={id('dob')}
          label={t('dateOfBirth')}
          type="date"
          value={value.dateOfBirth}
          onChange={set('dateOfBirth')}
          min="1920-01-01"
          error={errors['dateOfBirth']}
        />
        <SelectField
          id={id('gender')}
          label={t('gender')}
          value={value.gender}
          onChange={set('gender')}
          placeholder={t('choose')}
          options={GENDERS.map((g) => ({ value: g, label: tEnum(`gender_${g}`) }))}
        />
        <SelectField
          id={id('religion')}
          label={t('religion')}
          value={value.religion}
          onChange={set('religion')}
          placeholder={t('choose')}
          options={RELIGIONS.map((r) => ({ value: r, label: tEnum(`religion_${r}`) }))}
        />
        <SelectField
          id={id('blood')}
          label={t('bloodGroup')}
          value={value.bloodGroup}
          onChange={set('bloodGroup')}
          placeholder={t('choose')}
          options={BLOOD_GROUPS.map((b) => ({ value: b, label: BLOOD_GROUP_LABEL[b] }))}
        />
      </div>
    </div>
  );
}

/** Fields the education boards need for registration (SSC/JSC etc.). */
export function BoardFields({
  value,
  onChange,
  errors,
  idPrefix = 'st',
}: {
  value: StudentFormValues;
  onChange: (v: StudentFormValues) => void;
  errors: Record<string, string | undefined>;
  idPrefix?: string;
}) {
  const t = useTranslations('admission');
  const set = (k: keyof StudentFormValues) => (v: string) => onChange({ ...value, [k]: v });
  const id = (k: string) => `${idPrefix}-${k}`;
  const sameAddress =
    value.permanentAddress !== '' && value.permanentAddress === value.presentAddress;
  return (
    <div className="flex flex-col gap-4">
      <TextField
        id={id('birth-reg')}
        label={t('birthReg')}
        value={value.birthRegistrationNo}
        onChange={set('birthRegistrationNo')}
        inputMode="numeric"
        dir="ltr"
        maxLength={30}
        hint={t('birthRegHint')}
        error={errors['birthRegistrationNo']}
        className="sm:max-w-sm"
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id={id('father-bn')}
          label={t('fatherNameBn')}
          value={value.fatherNameBn}
          onChange={set('fatherNameBn')}
          lang="bn"
          maxLength={120}
        />
        <TextField
          id={id('father-en')}
          label={t('fatherNameEn')}
          value={value.fatherNameEn}
          onChange={set('fatherNameEn')}
          lang="en"
          maxLength={120}
        />
        <TextField
          id={id('mother-bn')}
          label={t('motherNameBn')}
          value={value.motherNameBn}
          onChange={set('motherNameBn')}
          lang="bn"
          maxLength={120}
        />
        <TextField
          id={id('mother-en')}
          label={t('motherNameEn')}
          value={value.motherNameEn}
          onChange={set('motherNameEn')}
          lang="en"
          maxLength={120}
        />
      </div>
      <TextField
        id={id('present')}
        label={t('presentAddress')}
        value={value.presentAddress}
        onChange={set('presentAddress')}
        maxLength={300}
      />
      <ToggleField
        id={id('same-address')}
        checked={sameAddress}
        onChange={(on) => onChange({ ...value, permanentAddress: on ? value.presentAddress : '' })}
        label={t('sameAddress')}
      />
      {!sameAddress && (
        <TextField
          id={id('permanent')}
          label={t('permanentAddress')}
          value={value.permanentAddress}
          onChange={set('permanentAddress')}
          maxLength={300}
        />
      )}
    </div>
  );
}

/** Up to 4 guardians, exactly one primary (gets attendance SMS). */
export function GuardianFields({
  value,
  onChange,
  errors,
  single = false,
}: {
  value: GuardianFormValues[];
  onChange: (v: GuardianFormValues[]) => void;
  /** Keyed by guardian key, then field. */
  errors: Record<string, Record<string, string>>;
  /** One guardian only (adding to an existing student): no add/remove buttons. */
  single?: boolean;
}) {
  const t = useTranslations('admission');
  const tEnum = useTranslations('enums');
  const update = (key: string, patch: Partial<GuardianFormValues>) =>
    onChange(
      value.map((g) =>
        g.key === key ? { ...g, ...patch } : patch.isPrimary ? { ...g, isPrimary: false } : g,
      ),
    );
  return (
    <div className="flex flex-col gap-3" data-testid="guardian-fields">
      {value.map((g, i) => (
        <fieldset
          key={g.key}
          className={cn(
            'flex flex-col gap-3 rounded-lg border p-3',
            g.isPrimary && 'border-primary/50 bg-primary-soft/30',
          )}
          data-testid="guardian-row"
        >
          <legend className="sr-only">{t('guardianN', { n: i + 1 })}</legend>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">{t('guardianN', { n: i + 1 })}</span>
            <div className="flex flex-wrap items-center gap-2">
              {g.isPrimary ? (
                <span className="text-accent-foreground inline-flex items-center gap-1 text-sm font-medium">
                  <StarIcon aria-hidden className="size-4" />
                  {t('primary')}
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => update(g.key, { isPrimary: true })}
                >
                  <StarIcon aria-hidden />
                  {t('makePrimary')}
                </Button>
              )}
              {!single && value.length > 1 && (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('removeGuardian', { n: i + 1 })}
                  onClick={() => {
                    const rest = value.filter((x) => x.key !== g.key);
                    if (g.isPrimary && rest[0]) rest[0] = { ...rest[0], isPrimary: true };
                    onChange(rest);
                  }}
                >
                  <Trash2Icon aria-hidden />
                </Button>
              )}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              id={`${g.key}-phone`}
              label={t('phone')}
              value={g.phone}
              onChange={(v) => update(g.key, { phone: v })}
              required
              inputMode="tel"
              dir="ltr"
              placeholder="01XXXXXXXXX"
              hint={t('phoneHint')}
              error={errors[g.key]?.['phone']}
            />
            <SelectField
              id={`${g.key}-relation`}
              label={t('relation')}
              value={g.relation}
              onChange={(v) => update(g.key, { relation: v as GuardianRelation })}
              options={GUARDIAN_RELATIONS.map((r) => ({ value: r, label: tEnum(`relation_${r}`) }))}
            />
            <TextField
              id={`${g.key}-name-bn`}
              label={t('nameBn')}
              value={g.nameBn}
              onChange={(v) => update(g.key, { nameBn: v })}
              lang="bn"
              maxLength={120}
              error={errors[g.key]?.['nameBn']}
            />
            <TextField
              id={`${g.key}-name-en`}
              label={t('nameEn')}
              value={g.nameEn}
              onChange={(v) => update(g.key, { nameEn: v })}
              lang="en"
              maxLength={120}
            />
            <TextField
              id={`${g.key}-occupation`}
              label={t('occupation')}
              value={g.occupation}
              onChange={(v) => update(g.key, { occupation: v })}
              maxLength={120}
              className="sm:col-span-2"
            />
          </div>
        </fieldset>
      ))}
      <p className="text-muted-foreground text-sm">{t('guardiansHint')}</p>
      {!single && value.length < 4 && (
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          onClick={() =>
            onChange([
              ...value,
              newGuardian(
                value.length === 0,
                value.some((g) => g.relation === 'FATHER') ? 'MOTHER' : 'FATHER',
              ),
            ])
          }
          data-testid="add-guardian"
        >
          <PlusIcon aria-hidden />
          {t('addGuardian')}
        </Button>
      )}
    </div>
  );
}

export const guardianPayload = (g: GuardianFormValues) => ({
  phone: g.phone,
  nameBn: g.nameBn.trim() || null,
  nameEn: g.nameEn.trim() || null,
  relation: g.relation,
  isPrimary: g.isPrimary,
  occupation: g.occupation.trim() || null,
});

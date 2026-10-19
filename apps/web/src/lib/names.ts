import type { AuthResponse, StudentListItem } from '@jantrik/shared';
import type { Locale } from '@/i18n/config';

/** Name in the UI language, falling back to the other one. */
export const displayName = (bn: string | null, en: string | null, locale: Locale): string =>
  (locale === 'bn' ? (bn ?? en) : (en ?? bn)) ?? '';

/** A person's name: Bangla script in the Bangla UI when set, else `name` ("—" when unnamed). */
export const displayUserName = (
  user: Pick<AuthResponse['user'], 'name' | 'nameBn'> | undefined,
  locale: Locale,
): string => (user ? (locale === 'bn' ? (user.nameBn ?? user.name) : user.name) || '—' : '');

/** "ষষ্ঠ শ্রেণি" for an enrolment's class level. */
export const classLevelName = (
  enrolment: NonNullable<StudentListItem['enrolment']>,
  locale: Locale,
): string => displayName(enrolment.classLevel.nameBn, enrolment.classLevel.nameEn, locale);

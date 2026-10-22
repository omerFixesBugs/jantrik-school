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

/**
 * A Bangla noun "of" (the genitive), for an institute's own labels inside a sentence: শাখা →
 * শাখার, শ্রেণি → শ্রেণির, ব্যাচ → ব্যাচের. A vowel ending takes র, a consonant (its inherent অ)
 * takes ের. Never "শাখা-এর".
 */
export const bnGenitive = (word: string): string =>
  /[\u0985-\u0994\u09BE-\u09CC]$/.test(word.trim()) ? `${word.trim()}র` : `${word.trim()}ের`;

/** "ষষ্ঠ শ্রেণি" for an enrolment's class level. */
export const classLevelName = (
  enrolment: NonNullable<StudentListItem['enrolment']>,
  locale: Locale,
): string => displayName(enrolment.classLevel.nameBn, enrolment.classLevel.nameEn, locale);

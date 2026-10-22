'use client';

import { formatMonth, type Role } from '@jantrik/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useMeContext } from '@/lib/hooks';

type Locale = 'bn' | 'en';

/** The name in the UI language, falling back to the other one. */
export function pick(
  locale: string,
  value: { nameBn?: string | null; nameEn?: string | null } | null | undefined,
): string {
  if (!value) return '';
  return (locale === 'bn' ? (value.nameBn ?? value.nameEn) : (value.nameEn ?? value.nameBn)) ?? '';
}

/**
 * A due's period as people say it: a month ("অক্টোবর ২০২৬"), a term's name, "বার্ষিক" or
 * "এককালীন". Period keys come from the API ('YYYY-MM', 'T:<id>', 'Y', 'ONCE').
 */
export function usePeriodLabel() {
  const t = useTranslations('fees.common.period');
  const locale = useLocale() as Locale;
  return (due: { periodKey: string; term?: { nameBn: string; nameEn: string } | null }): string => {
    if (due.periodKey === 'ONCE') return t('ONCE');
    if (due.periodKey === 'Y') return t('Y');
    if (due.periodKey.startsWith('T:')) return pick(locale, due.term) || t('Y');
    return formatMonth(due.periodKey, locale);
  };
}

/** The caller's fee roles (UI hints only: the API decides). */
export function useFeeRoles(): {
  roles: Role[];
  isOwner: boolean;
  isAdmin: boolean;
  /** OWNER or ADMIN: setup, voids, waivers, reminders. */
  manages: boolean;
  /** May use the counter (OWNER, ADMIN or ACCOUNTANT). */
  collects: boolean;
} {
  const { data } = useMeContext();
  const roles = data?.roles ?? [];
  const isOwner = roles.includes('OWNER');
  const isAdmin = roles.includes('ADMIN');
  return {
    roles,
    isOwner,
    isAdmin,
    manages: isOwner || isAdmin,
    collects: isOwner || isAdmin || roles.includes('ACCOUNTANT'),
  };
}

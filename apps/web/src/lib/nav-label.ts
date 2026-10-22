'use client';

import { useTranslations } from 'next-intl';
import { useLabel } from '@/lib/hooks';
import type { NavKey } from '@/lib/navigation';

/** Nav item text. Uses tenant labels, so a coaching centre reads "Course & Batch". */
export function useNavLabel() {
  const t = useTranslations();
  const label = useLabel();
  return (key: NavKey): string => {
    switch (key) {
      case 'students':
        return t('students.title', { student: label('student', 'Student') });
      case 'setup':
        return t('nav.setup');
      case 'staff':
        return t('nav.staff');
      default:
        return t(`nav.${key}`);
    }
  };
}

'use client';

import { REGISTER_CODES, type AttendanceStatus } from '@jantrik/shared';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMeContext } from '@/lib/hooks';
import { cn } from '@/lib/utils';

export type AttendanceTab = 'take' | 'today' | 'register' | 'settings';

const TABS: { key: AttendanceTab; href: string; label: string; adminOnly?: boolean }[] = [
  { key: 'take', href: '/attendance', label: 'tabTake' },
  { key: 'today', href: '/attendance/today', label: 'tabToday' },
  { key: 'register', href: '/attendance/register', label: 'tabRegister' },
  { key: 'settings', href: '/attendance/settings', label: 'tabSettings', adminOnly: true },
];

/** The attendance area's pages. Wraps instead of scrolling on narrow phones. */
export function AttendanceTabs({ active }: { active: AttendanceTab }) {
  const t = useTranslations('reports');
  const { data } = useMeContext();
  const isAdmin = data?.roles.some((r) => r === 'OWNER' || r === 'ADMIN') ?? false;
  return (
    <nav aria-label={t('tabTake')} className="print:hidden">
      <ul className="flex flex-wrap gap-2">
        {TABS.filter((tab) => !tab.adminOnly || isAdmin).map((tab) => (
          <li key={tab.key} className="min-w-0">
            <Link
              href={tab.href}
              aria-current={tab.key === active ? 'page' : undefined}
              className={cn(
                'inline-flex min-h-(--control-h) max-w-full items-center rounded-md border px-3.5 text-sm font-medium transition-colors',
                'focus-visible:ring-ring focus-visible:ring-offset-background outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                tab.key === active
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card hover:border-primary/40',
              )}
            >
              {t(tab.label)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Register cell colours (same meaning as on the take-attendance screen). */
export const STATUS_TONE: Record<AttendanceStatus, string> = {
  PRESENT: 'bg-success-soft text-success',
  ABSENT: 'bg-destructive text-white dark:text-[#2a0c09]',
  LATE: 'bg-warning-soft text-warning',
  LEAVE: 'bg-muted text-muted-foreground',
};

export const statusCode = (status: AttendanceStatus, locale: 'bn' | 'en') =>
  REGISTER_CODES[locale][status];

export const isAdminRole = (roles: string[] | undefined) =>
  roles?.some((r) => r === 'OWNER' || r === 'ADMIN') ?? false;

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useFeeRoles } from '@/lib/fees';
import { cn } from '@/lib/utils';

type FeeTab = 'counter' | 'submissions' | 'closing' | 'reports' | 'reminders' | 'setup';

const TABS: { key: FeeTab; href: string; managersOnly?: boolean }[] = [
  { key: 'counter', href: '/fees' },
  { key: 'submissions', href: '/fees/submissions' },
  { key: 'closing', href: '/fees/closing' },
  { key: 'reports', href: '/fees/reports' },
  { key: 'reminders', href: '/fees/reminders', managersOnly: true },
  { key: 'setup', href: '/fees/setup', managersOnly: true },
];

/**
 * The fee area's sections as a scrollable row of pills (role-filtered: reminders and setup are
 * for OWNER/ADMIN). The current one is marked for screen readers; never printed.
 */
export function FeesTabs() {
  const t = useTranslations('fees.common.tabs');
  const pathname = usePathname();
  const { manages } = useFeeRoles();
  const current = (href: string) =>
    href === '/fees'
      ? pathname === '/fees' ||
        pathname.startsWith('/fees/students') ||
        pathname.startsWith('/fees/receipts')
      : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <nav
      aria-label={t('counter')}
      className="-mx-1 overflow-x-auto px-1 print:hidden"
      data-testid="fees-tabs"
    >
      <ul className="flex w-max gap-2 py-1">
        {TABS.filter((tab) => !tab.managersOnly || manages).map((tab) => (
          <li key={tab.key}>
            <Link
              href={tab.href}
              aria-current={current(tab.href) ? 'page' : undefined}
              data-testid={`fees-tab-${tab.key}`}
              className={cn(
                'inline-flex min-h-(--control-h) items-center rounded-full border px-4 text-sm font-medium whitespace-nowrap transition-colors',
                'focus-visible:ring-ring focus-visible:ring-3 focus-visible:outline-none',
                current(tab.href)
                  ? 'border-primary-ink bg-primary-soft text-accent-foreground'
                  : 'bg-card hover:bg-muted',
              )}
            >
              {t(tab.key)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

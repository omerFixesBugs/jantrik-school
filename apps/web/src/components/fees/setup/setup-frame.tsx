'use client';

import {
  BadgePercentIcon,
  CalendarRangeIcon,
  HandCoinsIcon,
  LockIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  TableIcon,
  TagsIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, type ReactNode } from 'react';
import { FeesTabs } from '@/components/fees/fees-tabs';
import { PageGate } from '@/components/page-gate';
import { ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useFeeRoles } from '@/lib/fees';
import { useMeContext } from '@/lib/hooks';
import { cn } from '@/lib/utils';

export type FeeSetupTab =
  'general' | 'heads' | 'amounts' | 'terms' | 'concessions' | 'siblings' | 'numbers' | 'collectors';

const TABS: { key: FeeSetupTab; href: string; icon: LucideIcon }[] = [
  { key: 'general', href: '/fees/setup', icon: SlidersHorizontalIcon },
  { key: 'heads', href: '/fees/setup/heads', icon: TagsIcon },
  { key: 'amounts', href: '/fees/setup/amounts', icon: TableIcon },
  { key: 'terms', href: '/fees/setup/terms', icon: CalendarRangeIcon },
  { key: 'concessions', href: '/fees/setup/concessions', icon: BadgePercentIcon },
  { key: 'siblings', href: '/fees/setup/siblings', icon: UsersIcon },
  { key: 'numbers', href: '/fees/setup/numbers', icon: SmartphoneIcon },
  { key: 'collectors', href: '/fees/setup/collectors', icon: HandCoinsIcon },
];

/**
 * Fee setup's frame (OWNER/ADMIN): the fee tabs, then the setup sections as a list beside the
 * content from 1024 px, or a row of tabs that scrolls sideways above it on a phone. An
 * accountant (who may open the fee area) is told plainly who sets fees up. The API decides too.
 */
export function FeeSetupFrame({ tab, children }: { tab: FeeSetupTab; children: ReactNode }) {
  const { data: context } = useMeContext();
  const { manages } = useFeeRoles();
  return (
    <PageGate page="fees">
      <div className="flex flex-col gap-(--section-gap)">
        <FeesTabs />
        {!context ? (
          <Skeleton className="h-96 rounded-xl" />
        ) : !manages ? (
          <ManagersOnly />
        ) : (
          <div
            className="grid grid-cols-1 gap-(--section-gap) lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:items-start"
            data-testid="fees-setup"
          >
            <SetupNav active={tab} />
            <div className="flex min-w-0 flex-col gap-(--section-gap)">{children}</div>
          </div>
        )}
      </div>
    </PageGate>
  );
}

function SetupNav({ active }: { active: FeeSetupTab }) {
  const t = useTranslations('fees.setup');
  const current = useRef<HTMLAnchorElement>(null);
  // On a phone the row scrolls sideways: bring the open section into view (once, sideways only).
  useEffect(() => {
    const link = current.current;
    const row = link?.closest('ul');
    if (!link || !row || row.scrollWidth <= row.clientWidth) return;
    row.scrollLeft = link.offsetLeft - (row.clientWidth - link.offsetWidth) / 2;
  }, []);
  return (
    <nav aria-label={t('nav')} className="min-w-0 lg:sticky lg:top-[calc(var(--topbar-h)+1rem)]">
      <ul className="-mx-1 flex gap-1 overflow-x-auto border-b px-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:border-b-0 lg:px-0">
        {TABS.map(({ key, href, icon: Icon }) => {
          const on = key === active;
          return (
            <li key={key} className="shrink-0">
              <Link
                ref={on ? current : undefined}
                href={href}
                aria-current={on ? 'page' : undefined}
                data-testid={`fees-setup-tab-${key}`}
                className={cn(
                  'flex min-h-(--control-h) items-center gap-2 border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors',
                  'focus-visible:ring-ring rounded-t-md outline-none focus-visible:ring-2',
                  'lg:rounded-full lg:border-b-0 lg:px-4',
                  on
                    ? 'border-primary-ink text-foreground lg:bg-primary-soft lg:text-accent-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground lg:hover:bg-muted border-transparent',
                )}
              >
                <Icon aria-hidden className="hidden size-4.5 shrink-0 lg:block" />
                {t(`tabs.${key}`)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** An accountant opened setup: who does it, and where their own work is. */
function ManagersOnly() {
  const t = useTranslations('fees.setup');
  return (
    <div
      className="bg-card rounded-card shadow-card flex flex-col items-center gap-3 border px-6 py-12 text-center"
      data-testid="fees-setup-managers-only"
    >
      <span className="bg-primary-soft text-primary-ink flex size-12 items-center justify-center rounded-xl">
        <LockIcon aria-hidden className="size-6" />
      </span>
      <h2 className="text-lg font-semibold">{t('managersOnlyTitle')}</h2>
      <p className="text-muted-foreground max-w-prose">{t('managersOnlyText')}</p>
      <ButtonLink href="/fees" variant="outline" className="mt-1">
        {t('goToCounter')}
      </ButtonLink>
    </div>
  );
}

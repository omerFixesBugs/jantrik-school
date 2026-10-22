'use client';

import { useQuery } from '@tanstack/react-query';
import { formatBdPhone, type StaffMember, type StaffRole } from '@jantrik/shared';
import {
  ArrowRightIcon,
  CircleSlashIcon,
  HandCoinsIcon,
  HourglassIcon,
  PhoneIcon,
  PowerOffIcon,
  type LucideIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { SectionCard } from '@/components/form-kit';
import { Pill } from '@/components/kit/pill';
import { PersonAvatar } from '@/components/person-avatar';
import { ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { displayUserName } from '@/lib/names';
import { cn } from '@/lib/utils';
import { EmptyState, LoadError } from './kit';

const COLLECTS: StaffRole[] = ['OWNER', 'ADMIN', 'ACCOUNTANT'];

/** Not active, said with an icon and a word. */
const STATUS_ICON: Record<Exclude<StaffMember['status'], 'ACTIVE'>, LucideIcon> = {
  DISABLED: PowerOffIcon,
  INVITED: HourglassIcon,
  EXPIRED: CircleSlashIcon,
  DECLINED: CircleSlashIcon,
};

/** Who may take fees (OWNER, ADMIN, ACCOUNTANT); roles are changed on the staff page. */
export function CollectorsSection() {
  const t = useTranslations('fees.setup.collectors');
  const { client, session } = useAuth();
  // The staff page's own query (same key), so both stay in step.
  const staff = useQuery({
    queryKey: ['staff', session?.tenant?.id],
    queryFn: () => client.api<StaffMember[]>('/staff'),
  });
  const collectors = (staff.data ?? [])
    .filter((m) => m.roles.some((r) => COLLECTS.includes(r)))
    .sort(
      (a, b) =>
        Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE') ||
        Number(b.roles.includes('ACCOUNTANT')) - Number(a.roles.includes('ACCOUNTANT')),
    );
  return (
    <SectionCard
      id="fees-collectors"
      title={t('title')}
      hint={t('hint')}
      actions={
        <ButtonLink href="/staff" variant="outline" data-testid="fee-collectors-staff-link">
          {t('toStaff')}
          <ArrowRightIcon aria-hidden className="rtl:rotate-180" />
        </ButtonLink>
      }
    >
      {staff.isPending ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : staff.isError ? (
        <LoadError error={staff.error} onRetry={() => void staff.refetch()} />
      ) : collectors.length === 0 ? (
        <EmptyState icon={HandCoinsIcon} title={t('empty')} />
      ) : (
        <ul className="grid gap-2 lg:grid-cols-2" data-testid="fee-collectors">
          {collectors.map((m) => (
            <CollectorRow key={m.userId} member={m} />
          ))}
        </ul>
      )}
      <p className="text-muted-foreground max-w-prose text-sm">{t('teacherNote')}</p>
    </SectionCard>
  );
}

function CollectorRow({ member: m }: { member: StaffMember }) {
  const t = useTranslations('fees.setup.collectors');
  const tRoles = useTranslations('roles');
  const locale = useLocale() as Locale;
  const name = displayUserName(m, locale);
  const manages = m.roles.includes('OWNER') || m.roles.includes('ADMIN');
  const active = m.status === 'ACTIVE';
  return (
    <li
      className={cn('flex min-w-0 items-start gap-3 rounded-xl border p-3', !active && 'bg-muted')}
      data-testid="fee-collector-row"
      data-user-id={m.userId}
    >
      <PersonAvatar name={name} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-semibold wrap-break-word">
          {name}
          {m.isSelf && <span className="text-muted-foreground font-normal"> ({t('you')})</span>}
        </span>
        <a
          href={`tel:${m.phone}`}
          className="text-muted-foreground hover:text-foreground inline-flex min-h-(--control-h-xs) w-fit items-center gap-1 text-sm"
          dir="ltr"
        >
          <PhoneIcon aria-hidden className="size-3.5" />
          {formatBdPhone(m.phone)}
        </a>
        <span className="flex flex-wrap gap-1.5">
          {m.roles.map((r) => (
            <Pill key={r} tone={r === 'ACCOUNTANT' ? 'accent' : 'neutral'}>
              {tRoles(r)}
            </Pill>
          ))}
          {m.status !== 'ACTIVE' && <StatusPill status={m.status} />}
        </span>
        <span className="text-muted-foreground text-sm">
          {manages ? t('canManage') : t('canCollect')}
        </span>
      </div>
    </li>
  );
}

function StatusPill({ status }: { status: Exclude<StaffMember['status'], 'ACTIVE'> }) {
  const t = useTranslations('fees.setup.collectors');
  const Icon = STATUS_ICON[status];
  return (
    <Pill tone="warning">
      <Icon aria-hidden className="size-3.5" />
      {t(`status.${status}`)}
    </Pill>
  );
}

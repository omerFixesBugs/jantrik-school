'use client';

import { formatCount, formatDate, formatTime, type PlatformAuditEntry } from '@jantrik/shared';
import { useQuery } from '@tanstack/react-query';
import { ClockIcon, KeyRoundIcon, ShieldCheckIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { SectionCard } from '@/components/form-kit';
import { AuditList } from '@/components/platform/audit-list';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { usePlatformMe } from '@/lib/platform/hooks';
import { platformApi } from '@/lib/platform/platform-api';

/** Platform overview: the admin's account (2FA, backup codes, session) and recent activity. */
export default function PlatformOverviewPage() {
  const t = useTranslations('platform');
  const locale = useLocale() as Locale;
  const me = usePlatformMe().data!;
  const recent = useQuery({
    queryKey: ['platform-audit', 'recent'],
    queryFn: () => platformApi<PlatformAuditEntry[]>('/platform/audit?limit=10'),
  });
  const ends = me.sessionExpiresAt ? new Date(me.sessionExpiresAt) : null;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold">{t('hello', { name: me.name })}</h1>
        <p className="text-muted-foreground">{t('overviewText')}</p>
      </div>
      {me.backupCodesLeft <= 3 && (
        <Alert variant="destructive" data-testid="platform-backup-low">
          <KeyRoundIcon aria-hidden />
          <AlertDescription>
            {t('backupLow', { count: formatCount(me.backupCodesLeft, locale) })}
          </AlertDescription>
        </Alert>
      )}
      <SectionCard id="platform-account" title={t('accountTitle')}>
        <dl className="grid gap-4 sm:grid-cols-3" data-testid="platform-me">
          <Fact icon={ShieldCheckIcon} label={t('twoFactor')}>
            {me.totpEnabledAt
              ? t('twoFactorOn', { date: formatDate(new Date(me.totpEnabledAt), locale, 'medium') })
              : t('twoFactorOff')}
          </Fact>
          <Fact icon={KeyRoundIcon} label={t('backupLeft')}>
            {formatCount(me.backupCodesLeft, locale)}
          </Fact>
          <Fact icon={ClockIcon} label={t('sessionEnds')}>
            {ends ? `${formatDate(ends, locale, 'medium')} · ${formatTime(ends, locale)}` : '—'}
          </Fact>
        </dl>
      </SectionCard>
      <SectionCard
        id="platform-recent"
        title={t('recentTitle')}
        actions={
          <ButtonLink href="/platform/audit" variant="outline" size="sm">
            {t('allActivity')}
          </ButtonLink>
        }
      >
        {recent.data ? <AuditList entries={recent.data} /> : <Skeleton className="h-40" />}
      </SectionCard>
    </div>
  );
}

function Fact({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof ClockIcon;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="bg-primary-soft text-primary flex size-10 shrink-0 items-center justify-center rounded-lg">
        <Icon aria-hidden className="size-5" />
      </span>
      <div className="flex min-w-0 flex-col">
        <dt className="text-muted-foreground text-sm">{label}</dt>
        <dd className="font-medium break-words">{children}</dd>
      </div>
    </div>
  );
}

'use client';

import { ArrowLeftIcon, LockIcon, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { ButtonLink } from '@/components/ui/button';
import { useGuardianFeesOn } from './use-child-fees';

/**
 * A centred message with an icon tile and the way back to the dashboard: the same look as the
 * page gate's notice (components/page-gate.tsx), for guardian pages.
 */
export function GuardianNotice({
  icon: Icon = LockIcon,
  title,
  text,
  testId,
}: {
  icon?: LucideIcon;
  title: string;
  text: string;
  testId?: string;
}) {
  const t = useTranslations('comingSoon');
  return (
    <div
      className="bg-card flex flex-col items-center gap-3 rounded-xl border px-6 py-14 text-center shadow-xs"
      data-testid={testId}
    >
      <span className="bg-primary-soft text-primary-ink flex size-14 items-center justify-center rounded-2xl">
        <Icon aria-hidden className="size-7" />
      </span>
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="text-muted-foreground max-w-md">{text}</p>
      <ButtonLink variant="outline" className="mt-2" href="/dashboard">
        <ArrowLeftIcon aria-hidden />
        {t('back')}
      </ButtonLink>
    </div>
  );
}

/**
 * Guardian fee pages: only for a guardian of an institute that runs FEES. Anyone else sees the
 * "not available" notice. A UI hint only: the API enforces both (and 404s other children).
 */
export function GuardianFeesGate({ children }: { children: ReactNode }) {
  const t = useTranslations('notAvailable');
  const on = useGuardianFeesOn();
  if (on === undefined) return null;
  if (!on) {
    return (
      <GuardianNotice title={t('title')} text={t('text')} testId="guardian-fees-unavailable" />
    );
  }
  return <>{children}</>;
}

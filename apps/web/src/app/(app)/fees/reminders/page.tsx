'use client';

import { ArrowLeftIcon, LockIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Suspense } from 'react';
import { FeesTabs } from '@/components/fees/fees-tabs';
import { ReminderComposer } from '@/components/fees/reports/reminders';
import { PageGate } from '@/components/page-gate';
import { ButtonLink } from '@/components/ui/button';
import { useFeeRoles } from '@/lib/fees';

export default function FeeRemindersPage() {
  return (
    <PageGate page="fees">
      {/* The filter and the run being watched live in the URL (useSearchParams). */}
      <Suspense>
        <Reminders />
      </Suspense>
    </PageGate>
  );
}

/** Due reminder SMS: OWNER/ADMIN only (they cost the institute money); the API says so too. */
function Reminders() {
  const { manages } = useFeeRoles();
  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="fees-reminders">
      <FeesTabs />
      {manages ? <ReminderComposer /> : <ManagersOnly />}
    </div>
  );
}

function ManagersOnly() {
  const t = useTranslations('fees.reports.common');
  const tTabs = useTranslations('fees.common.tabs');
  return (
    <div
      data-slot="card"
      className="bg-card rounded-card shadow-card flex flex-col items-center gap-3 border px-6 py-12 text-center"
      data-testid="reminders-not-allowed"
    >
      <span className="bg-primary-soft text-primary-ink flex size-14 items-center justify-center rounded-xl">
        <LockIcon aria-hidden className="size-7" />
      </span>
      <h2 className="text-lg font-semibold">{t('managersOnlyTitle')}</h2>
      <p className="text-muted-foreground max-w-md text-sm">{t('managersOnlyText')}</p>
      <ButtonLink variant="outline" href="/fees/reports?tab=defaulters" className="mt-1">
        <ArrowLeftIcon aria-hidden className="rtl:rotate-180" />
        {tTabs('reports')}
      </ButtonLink>
    </div>
  );
}

'use client';

import { useQuery } from '@tanstack/react-query';
import { isoDateSchema, type MySectionsResponse } from '@jantrik/shared';
import { useLocale } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { RegisterView } from '@/components/attendance/register-view';
import { SectionPicker } from '@/components/attendance/section-picker';
import { PageGate } from '@/components/page-gate';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useMeContext } from '@/lib/hooks';
import { displayName } from '@/lib/names';

export default function AttendancePage() {
  return (
    <PageGate page="attendance">
      <Suspense>
        <Attendance />
      </Suspense>
    </PageGate>
  );
}

/** `/attendance` picks a section; `/attendance?section=…[&period=n][&date=YYYY-MM-DD]` takes it. */
function Attendance() {
  const params = useSearchParams();
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const tenantId = session?.tenant?.id ?? '';
  const sectionId = params.get('section');
  const periodNo = Math.max(0, Math.min(20, Number(params.get('period') ?? 0) || 0));
  const rawDate = params.get('date');
  const date = rawDate && isoDateSchema.safeParse(rawDate).success ? rawDate : undefined;

  // Shared with the picker (cached): gives the section's name and whether to show "back".
  const mine = useQuery({
    queryKey: ['attendance-my-sections', tenantId],
    queryFn: () => client.api<MySectionsResponse>('/attendance/my-sections'),
    enabled: Boolean(sectionId),
  });

  if (!sectionId) return <SectionPicker />;
  const isAdmin = context?.roles.some((r) => r === 'OWNER' || r === 'ADMIN') ?? false;
  const section = mine.data?.sections.find((s) => s.id === sectionId);
  return (
    <RegisterView
      // A new register (section, period, date) gets a fresh controller.
      key={`${sectionId}:${periodNo}:${date ?? 'today'}`}
      sectionId={sectionId}
      periodNo={periodNo}
      date={date}
      sectionName={
        section
          ? `${displayName(section.classLevel.nameBn, section.classLevel.nameEn, locale)}, ${section.name}`
          : ''
      }
      showBack={isAdmin || (mine.data?.sections.length ?? 0) !== 1}
    />
  );
}

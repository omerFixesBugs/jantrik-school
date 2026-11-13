'use client';

import { isoDateSchema, type IsoDate } from '@jantrik/shared';
import { LockIcon } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense } from 'react';
import { AttendanceTabs, isAdminRole } from '@/components/attendance/attendance-tabs';
import { SegmentedControl } from '@/components/kit/segmented-control';
import { PageGate } from '@/components/page-gate';
import { StaffDayView } from '@/components/staff-attendance/day-view';
import { StaffMonthView } from '@/components/staff-attendance/month-view';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useMeContext } from '@/lib/hooks';

export default function StaffAttendancePage() {
  const t = useTranslations('staffAttendance.common');
  const { data: context } = useMeContext();
  return (
    <PageGate page="attendance">
      <div className="flex flex-col gap-5">
        <AttendanceTabs active="staff" />
        {!context ? (
          <Skeleton className="rounded-card h-72" />
        ) : isAdminRole(context.roles) ? (
          <Suspense>
            <StaffAttendance today={context.today} />
          </Suspense>
        ) : (
          <>
            <h2 className="text-xl font-semibold sm:text-2xl">{t('title')}</h2>
            <Alert>
              <LockIcon aria-hidden />
              <AlertDescription>{t('adminOnly')}</AlertDescription>
            </Alert>
          </>
        )}
      </div>
    </PageGate>
  );
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * `/attendance/staff[?date=YYYY-MM-DD]`: the day (today by default, never a future date);
 * `?view=month[&month=YYYY-MM]`: the month. Today is the server's, never the device's.
 */
function StaffAttendance({ today }: { today: IsoDate }) {
  const t = useTranslations('staffAttendance.common');
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const view = params.get('view') === 'month' ? 'month' : 'day';
  const rawDate = params.get('date');
  const date =
    rawDate && isoDateSchema.safeParse(rawDate).success && rawDate <= today ? rawDate : today;
  const thisMonth = today.slice(0, 7);
  const rawMonth = params.get('month');
  const month = rawMonth && MONTH_RE.test(rawMonth) && rawMonth <= thisMonth ? rawMonth : thisMonth;

  const go = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null) q.delete(k);
      else q.set(k, v);
    }
    const s = q.toString();
    router.replace(s ? `${pathname}?${s}` : pathname);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="staff-attendance">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-xl font-semibold sm:text-2xl">{t('title')}</h2>
          <p className="text-muted-foreground max-w-prose text-sm">{t('subtitle')}</p>
        </div>
        <SegmentedControl
          label={t('view')}
          value={view}
          onChange={(v) => go({ view: v === 'month' ? 'month' : null })}
          options={[
            { value: 'day', label: t('viewDay') },
            { value: 'month', label: t('viewMonth') },
          ]}
          testId="staff-view"
        />
      </div>
      {view === 'day' ? (
        <StaffDayView
          date={date}
          today={today}
          onDate={(d) => go({ date: d === today ? null : d })}
        />
      ) : (
        <StaffMonthView
          month={month}
          thisMonth={thisMonth}
          onMonth={(m) => go({ month: m === thisMonth ? null : m })}
        />
      )}
    </div>
  );
}

'use client';

import { useQuery } from '@tanstack/react-query';
import {
  addDays,
  dateToDb,
  formatCount,
  formatDate,
  formatIdentifier,
  isoDateSchema,
  type MySectionsResponse,
  type StudentAttendanceReport,
} from '@jantrik/shared';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Suspense } from 'react';
import { AttendanceTabs, STATUS_TONE, statusCode } from '@/components/attendance/attendance-tabs';
import { CountChips } from '@/components/attendance/count-chips';
import { PageGate } from '@/components/page-gate';
import { PersonAvatar } from '@/components/person-avatar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { DateInput } from '@/components/date-input';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage } from '@/lib/hooks';
import { displayName } from '@/lib/names';
import { cn } from '@/lib/utils';

export default function StudentAttendancePage() {
  return (
    <PageGate page="attendance">
      <div className="flex flex-col gap-5">
        <AttendanceTabs active="today" />
        <Suspense>
          <StudentReport />
        </Suspense>
      </div>
    </PageGate>
  );
}

const valid = (d: string | null) => (d && isoDateSchema.safeParse(d).success ? d : null);

function StudentReport() {
  const t = useTranslations('reports');
  const tAtt = useTranslations('attendance');
  const tCommon = useTranslations('common');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id ?? '';

  // "Today" is the server's (tenant timezone), never the phone's.
  const mine = useQuery({
    queryKey: ['attendance-my-sections', tenantId],
    queryFn: () => client.api<MySectionsResponse>('/attendance/my-sections'),
  });
  const today = mine.data?.today;
  const to = valid(params.get('to')) ?? today ?? null;
  const from = valid(params.get('from')) ?? (today ? `${today.slice(0, 7)}-01` : null);

  const report = useQuery({
    queryKey: ['attendance-student', tenantId, id, from, to],
    queryFn: () =>
      client.api<StudentAttendanceReport>(
        `/attendance/reports/students/${id}?${new URLSearchParams({ from: from!, to: to! })}`,
      ),
    enabled: Boolean(from && to && from <= to),
  });

  const setRange = (f: string, tt: string) =>
    router.replace(`${pathname}?${new URLSearchParams({ from: f, to: tt })}`);
  const presets = today
    ? [
        { key: 'rangeMonth', from: `${today.slice(0, 7)}-01`, to: today },
        { key: 'range30', from: addDays(today, -29), to: today },
        { key: 'rangeYear', from: `${today.slice(0, 4)}-01-01`, to: today },
      ]
    : [];

  const r = report.data;
  const attended = r ? r.counts.present + r.counts.late : 0;
  const counted = r
    ? r.counts.present +
      r.counts.late +
      r.counts.absent +
      (r.leaveCountsAsAbsent ? r.counts.leave : 0)
    : 0;

  return (
    <div className="flex flex-col gap-5" data-testid="student-report">
      {r ? (
        <div className="flex items-center gap-4">
          <PersonAvatar name={displayName(r.student.nameBn, r.student.nameEn, locale)} size="lg" />
          <div className="flex min-w-0 flex-col">
            <h2 className="text-xl font-semibold break-words sm:text-2xl">
              {displayName(r.student.nameBn, r.student.nameEn, locale)}
            </h2>
            <p className="text-muted-foreground text-sm">
              {r.student.section && (
                <>
                  {displayName(
                    r.student.section.classLevel.nameBn,
                    r.student.section.classLevel.nameEn,
                    locale,
                  )}
                  , {r.student.section.name}
                </>
              )}
              {r.student.roll != null && (
                <>
                  {' · '}
                  {t('colRoll')}{' '}
                  <span className="tabular-nums">{formatIdentifier(r.student.roll)}</span>
                </>
              )}
            </p>
          </div>
        </div>
      ) : (
        <h2 className="text-xl font-semibold sm:text-2xl">{t('studentTitle')}</h2>
      )}

      <form
        className="bg-card flex flex-col gap-3 rounded-xl border p-4 shadow-xs"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const f = valid(String(data.get('from')));
          const tt = valid(String(data.get('to')));
          if (f && tt && f <= tt) setRange(f, tt);
        }}
      >
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <Button
              key={p.key}
              type="button"
              size="sm"
              variant={p.from === from && p.to === to ? 'default' : 'outline'}
              onClick={() => setRange(p.from, p.to)}
            >
              {t(p.key)}
            </Button>
          ))}
        </div>
        {from && to && (
          <div className="flex flex-wrap items-end gap-3" key={`${from}:${to}`}>
            <div className="flex min-w-36 flex-1 flex-col gap-1.5">
              <Label htmlFor="range-from">{t('from')}</Label>
              <DateInput id="range-from" name="from" defaultValue={from} max={today} />
            </div>
            <div className="flex min-w-36 flex-1 flex-col gap-1.5">
              <Label htmlFor="range-to">{t('to')}</Label>
              <DateInput id="range-to" name="to" defaultValue={to} max={today} />
            </div>
            <Button type="submit" variant="outline">
              {tCommon('apply')}
            </Button>
          </div>
        )}
      </form>

      {report.isPending || mine.isPending ? (
        <Skeleton className="h-40 rounded-xl" aria-busy="true" aria-label={tCommon('loading')} />
      ) : report.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{describe(report.error)}</AlertDescription>
        </Alert>
      ) : (
        r && (
          <>
            <section className="bg-card flex flex-col gap-3 rounded-xl border p-4 shadow-xs sm:p-5">
              <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
                <p
                  className="font-numeric text-primary-ink text-4xl font-semibold"
                  data-testid="student-percent"
                >
                  {r.percent === null ? '—' : `${formatCount(Math.round(r.percent), locale)}%`}
                </p>
                <p className="text-muted-foreground text-sm">
                  {t('presentDays', {
                    present: formatCount(attended, locale),
                    days: formatCount(counted, locale),
                  })}
                  <br />
                  {r.leaveCountsAsAbsent ? t('leaveCounted') : t('leaveExcluded')}
                </p>
              </div>
              <CountChips counts={r.counts} />
            </section>

            <section className="flex flex-col gap-2" aria-labelledby="days-list">
              <h3 id="days-list" className="text-lg font-semibold">
                {t('daysList')}
              </h3>
              {r.days.length === 0 ? (
                <p className="text-muted-foreground">{t('noRecords')}</p>
              ) : (
                <ul className="bg-card flex flex-col divide-y rounded-xl border">
                  {r.days.map((d) => (
                    <li
                      key={d.date}
                      className="flex min-h-11 items-center justify-between gap-3 px-4 py-1.5"
                    >
                      <span className="min-w-0">
                        {formatDate(dateToDb(d.date), locale, 'full')}
                      </span>
                      <span
                        className={cn(
                          'inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium whitespace-nowrap',
                          STATUS_TONE[d.status],
                        )}
                      >
                        <span aria-hidden>{statusCode(d.status, locale)}</span>
                        {tAtt(`status${d.status}`)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )
      )}
    </div>
  );
}

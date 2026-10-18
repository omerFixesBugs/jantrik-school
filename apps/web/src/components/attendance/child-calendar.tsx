'use client';

import { useQuery } from '@tanstack/react-query';
import {
  addMonths,
  dateToDb,
  formatCount,
  formatDate,
  formatMonth,
  isoWeekday,
  type AttendanceStatus,
  type ChildAttendanceMonth,
} from '@jantrik/shared';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { STATUS_TONE, statusCode } from '@/components/attendance/attendance-tabs';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage } from '@/lib/hooks';
import { cn } from '@/lib/utils';

const LEGEND: AttendanceStatus[] = ['PRESENT', 'ABSENT', 'LATE', 'LEAVE'];

/**
 * A month of the child's attendance, Saturday first (as on a Bangladeshi calendar): one square
 * per day, coloured by the day's status; weekly days off and holidays are greyed.
 */
export function ChildCalendar({ studentId }: { studentId: string }) {
  const t = useTranslations('reports');
  const tAtt = useTranslations('attendance');
  const tCommon = useTranslations('common');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const [month, setMonth] = useState<string | null>(null); // null = this month (server's)

  const q = useQuery({
    queryKey: ['child-attendance', session?.tenant?.id, studentId, month],
    queryFn: () =>
      client.api<ChildAttendanceMonth>(
        `/me/children/${studentId}/attendance${month ? `?month=${month}` : ''}`,
      ),
  });
  const data = q.data;
  const shown = data?.month ?? month;
  const thisMonth = data?.today.slice(0, 7);
  const weekdays = t('weekdays').split(',');

  return (
    <section
      className="flex flex-col gap-3 border-t px-4 py-4 sm:px-5"
      aria-label={t('calendarTitle')}
      data-testid="child-calendar"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="min-w-0 font-semibold">
          {t('calendarTitle')}
          {shown && (
            <span className="text-muted-foreground font-normal">
              , {formatMonth(shown, locale)}
            </span>
          )}
        </h4>
        <div className="flex shrink-0 gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t('prevMonth')}
            disabled={!shown}
            onClick={() => shown && setMonth(addMonths(shown, -1))}
          >
            <ChevronLeftIcon aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t('nextMonth')}
            disabled={!shown || !thisMonth || shown >= thisMonth}
            onClick={() => shown && setMonth(addMonths(shown, 1))}
          >
            <ChevronRightIcon aria-hidden />
          </Button>
        </div>
      </div>

      {q.isPending ? (
        <Skeleton className="h-56" aria-label={tCommon('loading')} />
      ) : q.isError ? (
        <p className="text-destructive text-sm">{describe(q.error)}</p>
      ) : (
        <>
          <p className="text-sm" data-testid="child-percent">
            {data!.percent === null ? (
              <span className="text-muted-foreground">{t('calendarNone')}</span>
            ) : (
              <span className="font-medium">
                {t('calendarPercent', {
                  percent: formatCount(Math.round(data!.percent), locale),
                })}
              </span>
            )}
          </p>
          <div aria-hidden className="grid grid-cols-7 gap-1 text-center">
            {weekdays.map((w) => (
              <span key={w} className="text-muted-foreground truncate text-xs font-medium">
                {w}
              </span>
            ))}
          </div>
          <ol className="grid grid-cols-7 gap-1 text-center">
            {/* Blank cells before the 1st (Saturday = column 0). */}
            {Array.from({ length: (isoWeekday(data!.days[0]!.date) + 1) % 7 }, (_, i) => (
              <li key={`pad-${i}`} aria-hidden />
            ))}
            {data!.days.map((d) => {
              const future = d.date > data!.today;
              const off = d.nonWorkingDay !== null;
              const text = future
                ? t('future')
                : d.status
                  ? tAtt(`status${d.status}`)
                  : off
                    ? d.nonWorkingDay!.reason === 'HOLIDAY'
                      ? locale === 'bn'
                        ? d.nonWorkingDay!.nameBn
                        : d.nonWorkingDay!.nameEn
                      : t('offDay')
                    : t('noRecord');
              return (
                <li
                  key={d.date}
                  aria-label={`${formatDate(dateToDb(d.date), locale, 'long')}: ${text}`}
                  title={text}
                  className={cn(
                    'flex aspect-square min-w-0 flex-col items-center justify-center rounded-md text-sm leading-none',
                    d.status
                      ? STATUS_TONE[d.status]
                      : off
                        ? 'bg-muted text-muted-foreground'
                        : 'border border-dashed',
                    future && 'opacity-50',
                    d.date === data!.today && 'ring-primary ring-2 ring-offset-1',
                  )}
                >
                  <span className="font-numeric font-medium">
                    {formatCount(Number(d.date.slice(8)), locale)}
                  </span>
                  {d.status && (
                    <span aria-hidden className="mt-0.5 text-[0.65rem] font-semibold">
                      {statusCode(d.status, locale)}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label={t('legend')}>
            {LEGEND.map((s) => (
              <li key={s} className="flex items-center gap-1.5">
                <span aria-hidden className={cn('size-3 rounded-sm', STATUS_TONE[s])} />
                {tAtt(`status${s}`)}{' '}
                <span className="font-numeric">
                  {formatCount(data!.counts[s.toLowerCase() as 'present'], locale)}
                </span>
              </li>
            ))}
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="bg-muted size-3 rounded-sm" />
              {t('offDay')}
            </li>
          </ul>
        </>
      )}
    </section>
  );
}

'use client';

import { useQuery } from '@tanstack/react-query';
import {
  addMonths,
  dateToDb,
  formatCount,
  formatDate,
  formatMonth,
  isoWeekday,
  STAFF_CELL_CODES,
  type StaffCell,
  type StaffMonthPerson,
  type StaffMonthReport,
} from '@jantrik/shared';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  PrinterIcon,
  RouterIcon,
  UsersIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { SourceTag } from '@/components/attendance/source-tag';
import { downloadFile, EmptyState, LoadError } from '@/components/fees/reports/kit';
import { SidePeek } from '@/components/side-peek';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useMeContext } from '@/lib/hooks';
import { useMediaQuery } from '@/lib/media';
import { cn } from '@/lib/utils';
import { DayStatusPill, MinutesPills, RoleBadges, staffKeys, staffName, timeText } from './kit';

/** Cell colours: the register's meanings (late and early leave are both "warning"). */
const CELL_TONE: Partial<Record<StaffCell, string>> = {
  PRESENT: 'bg-success-soft text-success',
  LATE: 'bg-warning-soft text-warning',
  EARLY: 'bg-warning-soft text-warning',
  LATE_EARLY: 'bg-warning-soft text-warning',
  ABSENT: 'bg-destructive text-destructive-foreground',
  LEAVE: 'bg-muted text-muted-foreground',
};
const LEGEND = ['PRESENT', 'LATE', 'EARLY', 'LATE_EARLY', 'ABSENT', 'LEAVE'] as const;
const TOTALS = ['present', 'late', 'early', 'absent', 'leave'] as const;
const TOTAL_CODE = {
  present: 'PRESENT',
  late: 'LATE',
  early: 'EARLY',
  absent: 'ABSENT',
  leave: 'LEAVE',
} as const;
const TOTAL_LABEL = {
  present: 'colPresent',
  late: 'colLate',
  early: 'colEarly',
  absent: 'colAbsent',
  leave: 'colLeave',
} as const;

/** People × days with codes and totals; a person's days beside it; print and the two CSVs. */
export function StaffMonthView({
  month,
  thisMonth,
  onMonth,
}: {
  month: string;
  thisMonth: string;
  onMonth: (month: string) => void;
}) {
  const t = useTranslations('staffAttendance');
  const tReports = useTranslations('reports');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const wide = useMediaQuery('(min-width: 1280px)');
  const [openId, setOpenId] = useState<string | null>(null);
  const [csvError, setCsvError] = useState(false);
  const [downloading, setDownloading] = useState<'grid' | 'days' | null>(null);
  const report = useQuery({
    queryKey: staffKeys.month(session?.tenant?.id, month),
    queryFn: () => client.api<StaffMonthReport>(`/staff-attendance/month?month=${month}`),
  });
  const r = report.data;
  const open = r?.people.find((p) => p.userId === openId) ?? null;
  const codes: Partial<Record<StaffCell, string>> = STAFF_CELL_CODES[locale];
  const weekdayNames = tReports('weekdays').split(',');
  // ISO weekday (1 = Monday) → the Saturday-first short names.
  const weekdayShort = (iso: number) => weekdayNames[(iso + 1) % 7]!;

  async function downloadCsv(kind: 'grid' | 'days') {
    setCsvError(false);
    setDownloading(kind);
    try {
      await downloadFile(
        client,
        `/staff-attendance/month/csv?${new URLSearchParams({ month, kind, locale })}`,
        t(kind === 'grid' ? 'month.csvFileGrid' : 'month.csvFileDays', { month }),
      );
    } catch {
      setCsvError(true);
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div
      className={cn(
        'print-area flex flex-col gap-4',
        // Beside the side peek, the grid makes room for it (it scrolls sideways anyway).
        open && wide && 'xl:pe-[calc(min(26rem,40vw)+0.75rem)] print:pe-0',
      )}
      data-testid="staff-month"
    >
      <div className="flex flex-col gap-3 print:hidden sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex items-center gap-1" role="group" aria-label={t('month.month')}>
          <Button
            variant="outline"
            size="icon"
            aria-label={t('month.prev')}
            onClick={() => onMonth(addMonths(month, -1))}
          >
            <ChevronLeftIcon aria-hidden />
          </Button>
          <span
            className="min-w-36 px-2 text-center font-medium"
            aria-live="polite"
            data-testid="staff-month-label"
          >
            {formatMonth(month, locale)}
          </span>
          <Button
            variant="outline"
            size="icon"
            aria-label={t('month.next')}
            disabled={month >= thisMonth}
            onClick={() => onMonth(addMonths(month, 1))}
          >
            <ChevronRightIcon aria-hidden />
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 sm:ms-auto">
          {(['grid', 'days'] as const).map((kind) => (
            <Button
              key={kind}
              variant="outline"
              onClick={() => void downloadCsv(kind)}
              disabled={!r || downloading !== null}
              data-testid={`staff-csv-${kind}`}
            >
              <DownloadIcon aria-hidden />
              {t(kind === 'grid' ? 'month.csvGrid' : 'month.csvDays')}
            </Button>
          ))}
          <Button
            variant="outline"
            onClick={() => window.print()}
            disabled={!r}
            data-testid="staff-print"
          >
            <PrinterIcon aria-hidden />
            {t('month.print')}
          </Button>
        </div>
      </div>
      {csvError && (
        <Alert variant="destructive" className="print:hidden">
          <AlertDescription>{t('month.csvFailed')}</AlertDescription>
        </Alert>
      )}

      {report.isPending ? (
        <Skeleton className="rounded-card h-72" aria-busy="true" />
      ) : report.isError ? (
        <LoadError error={report.error} onRetry={() => void report.refetch()} />
      ) : r!.people.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title={t('common.noStaffTitle')}
          hint={t('common.noStaffHint')}
          testId="staff-empty"
          action={
            <ButtonLink variant="outline" href="/staff">
              {t('common.staffLink')}
            </ButtonLink>
          }
        />
      ) : (
        <>
          {/* Print heading: the paper register's title block. */}
          <div className="hidden print:block">
            <p className="text-lg font-semibold">{context?.tenant.name}</p>
            <p>{t('month.printHeading', { month: formatMonth(r!.month, locale) })}</p>
          </div>

          {r!.people.every((p) => p.details.length === 0) && (
            <Alert className="print:hidden" data-testid="staff-month-empty">
              <RouterIcon aria-hidden />
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span className="max-w-prose">{t('month.noData')}</span>
                <ButtonLink size="sm" variant="outline" href="/attendance/devices">
                  {t('common.devicesLink')}
                </ButtonLink>
              </AlertDescription>
            </Alert>
          )}

          <ul
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
            aria-label={t('month.legend')}
          >
            {LEGEND.map((c) => (
              <li key={c} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={cn(
                    'inline-flex h-6 min-w-6 items-center justify-center rounded px-0.5 text-xs font-semibold',
                    CELL_TONE[c],
                  )}
                >
                  {codes[c]}
                </span>
                {t(`month.cell.${c}`)}
              </li>
            ))}
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="bg-muted register-off inline-block size-6 rounded" />
              {t('month.offDay')}
            </li>
          </ul>

          <div
            // relative: the headers' screen-reader labels stay inside the scrolling box.
            className="bg-card relative overflow-x-auto rounded-xl border shadow-xs print:overflow-visible print:rounded-none print:border-0 print:shadow-none"
            data-testid="staff-month-table"
          >
            <table className="register-table w-max min-w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="bg-card sticky left-0 z-10 border-r border-b px-3 py-2 text-left font-medium"
                  >
                    {t('month.colName')}
                  </th>
                  {r!.days.map((d) => (
                    <th
                      key={d.date}
                      scope="col"
                      title={d.holidayName ? d.holidayName[locale] : undefined}
                      className={cn(
                        'w-8 min-w-8 border-b px-0.5 py-1 text-center font-normal',
                        d.off && 'bg-muted register-off',
                      )}
                    >
                      <span className="font-numeric block font-medium">
                        {formatCount(Number(d.date.slice(8)), locale)}
                      </span>
                      <span className="text-muted-foreground block text-[0.7rem] leading-tight">
                        {weekdayShort(isoWeekday(d.date))}
                      </span>
                    </th>
                  ))}
                  {TOTALS.map((k) => (
                    <th
                      key={k}
                      scope="col"
                      title={t(`month.${TOTAL_LABEL[k]}`)}
                      className="w-9 min-w-9 border-b border-l px-1 py-1 text-center font-medium"
                    >
                      <span aria-hidden>{codes[TOTAL_CODE[k]]}</span>
                      <span className="sr-only">{t(`month.${TOTAL_LABEL[k]}`)}</span>
                    </th>
                  ))}
                  <th
                    scope="col"
                    title={t('month.colLateMinutes')}
                    className="border-b border-l px-1.5 py-1 text-center text-xs font-medium"
                  >
                    <span aria-hidden>{t('month.colLateMinutesShort')}</span>
                    <span className="sr-only">{t('month.colLateMinutes')}</span>
                  </th>
                  <th
                    scope="col"
                    title={t('month.colEarlyMinutes')}
                    className="border-b border-l px-1.5 py-1 text-center text-xs font-medium"
                  >
                    <span aria-hidden>{t('month.colEarlyMinutesShort')}</span>
                    <span className="sr-only">{t('month.colEarlyMinutes')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {r!.people.map((p) => {
                  const name = staffName(p, locale);
                  return (
                    <tr
                      key={p.userId}
                      className="group"
                      data-testid="staff-month-row"
                      data-user-id={p.userId}
                    >
                      <th
                        scope="row"
                        className={cn(
                          'bg-card group-hover:bg-muted sticky left-0 z-10 w-40 max-w-40 min-w-40 border-r border-b px-2 py-1 text-left font-normal sm:w-56 sm:max-w-56 sm:min-w-56',
                          openId === p.userId && 'bg-primary-soft',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => setOpenId(p.userId)}
                          aria-label={t('month.openPerson', { name })}
                          aria-expanded={openId === p.userId}
                          className="flex min-h-(--control-h-xs) w-full items-center text-left hover:underline"
                          data-testid="staff-month-person"
                        >
                          <span className="line-clamp-2 min-w-0 leading-snug break-words">
                            {name}
                          </span>
                        </button>
                      </th>
                      {p.cells.map((cell, i) => {
                        const d = r!.days[i]!;
                        const code = codes[cell];
                        return (
                          <td
                            key={d.date}
                            className={cn(
                              'border-b p-0.5 text-center',
                              d.off && 'bg-muted register-off',
                            )}
                          >
                            {code ? (
                              <span
                                className={cn(
                                  'inline-flex h-7 min-w-7 items-center justify-center rounded px-0.5 text-xs font-semibold',
                                  CELL_TONE[cell],
                                )}
                                title={t(`month.cell.${cell as (typeof LEGEND)[number]}`)}
                              >
                                {code}
                              </span>
                            ) : null}
                          </td>
                        );
                      })}
                      {TOTALS.map((k) => (
                        <td key={k} className="font-numeric border-b border-l px-1 text-center">
                          {formatCount(p.totals[k], locale)}
                        </td>
                      ))}
                      <td className="font-numeric border-b border-l px-1.5 text-center">
                        {formatCount(p.totals.lateMinutes, locale)}
                      </td>
                      <td className="font-numeric border-b border-l px-1.5 text-center">
                        {formatCount(p.totals.earlyMinutes, locale)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {open &&
        (wide ? (
          <SidePeek
            // A new person moves focus to their name, as a new page would.
            key={open.userId}
            title={staffName(open, locale)}
            onClose={() => setOpenId(null)}
            testId="staff-month-peek"
          >
            <PersonMonth person={open} />
          </SidePeek>
        ) : (
          <Sheet open onOpenChange={(o) => !o && setOpenId(null)}>
            <SheetContent
              side="right"
              className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
              data-testid="staff-month-sheet"
            >
              <SheetHeader className="pe-12">
                <SheetTitle className="text-lg">{staffName(open, locale)}</SheetTitle>
              </SheetHeader>
              <div className="px-4 pb-6">
                <PersonMonth person={open} />
              </div>
            </SheetContent>
          </Sheet>
        ))}
    </div>
  );
}

/** One person's month: the totals, then each recorded day's times, minutes, source and reason. */
function PersonMonth({ person: p }: { person: StaffMonthPerson }) {
  const t = useTranslations('staffAttendance');
  const locale = useLocale() as Locale;
  const f = (n: number) => formatCount(n, locale);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <span className="flex flex-wrap gap-1">
        <RoleBadges roles={p.roles} />
      </span>
      <div className="font-numeric flex flex-col gap-1">
        <p>
          {t('month.peekTotals', {
            present: f(p.totals.present),
            late: f(p.totals.late),
            early: f(p.totals.early),
            absent: f(p.totals.absent),
            leave: f(p.totals.leave),
          })}
        </p>
        <p className="text-muted-foreground">
          {t('month.peekMinutes', {
            late: f(p.totals.lateMinutes),
            early: f(p.totals.earlyMinutes),
          })}
        </p>
      </div>
      <section className="flex flex-col gap-2" aria-labelledby={`peek-days-${p.userId}`}>
        <h3 id={`peek-days-${p.userId}`} className="font-semibold">
          {t('month.peekDays')}
        </h3>
        {p.details.length === 0 ? (
          <p className="text-muted-foreground">{t('month.peekNone')}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border" data-testid="staff-peek-days">
            {p.details.map((d) => (
              <li key={d.date} className="flex flex-col gap-1.5 px-3 py-2">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {formatDate(dateToDb(d.date), locale, 'medium')}
                  </span>
                  <DayStatusPill status={d.status} state={null} />
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  {d.inAt && (
                    <span className="font-numeric">
                      {t('month.peekTimes', {
                        in: timeText(d.inAt, locale),
                        out: d.outAt ? timeText(d.outAt, locale) : '—',
                      })}
                    </span>
                  )}
                  <MinutesPills day={d} />
                  <SourceTag source={d.source} />
                </span>
                {d.reason && (
                  <span className="text-muted-foreground break-words">
                    {t('common.reason', { reason: d.reason })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

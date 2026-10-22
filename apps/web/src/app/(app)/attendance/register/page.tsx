'use client';

import { useQuery } from '@tanstack/react-query';
import {
  addMonths,
  formatCount,
  formatMonth,
  formatIdentifier,
  REGISTER_CODES,
  type AttendanceRegisterReport,
  type MySectionsResponse,
} from '@jantrik/shared';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  PrinterIcon,
  TableIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Suspense, useState } from 'react';
import { AttendanceTabs, STATUS_TONE } from '@/components/attendance/attendance-tabs';
import { PageGate } from '@/components/page-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel, useMeContext } from '@/lib/hooks';
import { displayName } from '@/lib/names';
import { cn } from '@/lib/utils';

export default function AttendanceRegisterPage() {
  return (
    <PageGate page="attendance">
      <div className="flex flex-col gap-5">
        <AttendanceTabs active="register" />
        <Suspense>
          <RegisterReport />
        </Suspense>
      </div>
    </PageGate>
  );
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const STATUSES = ['PRESENT', 'ABSENT', 'LATE', 'LEAVE'] as const;

function RegisterReport() {
  const t = useTranslations('reports');
  const tAtt = useTranslations('attendance');
  const tCommon = useTranslations('common');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const describe = useErrorMessage();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const tenantId = session?.tenant?.id ?? '';
  const sectionLabel = label('section', 'Section', { inText: true });

  const mine = useQuery({
    queryKey: ['attendance-my-sections', tenantId],
    queryFn: () => client.api<MySectionsResponse>('/attendance/my-sections'),
  });
  const sections = mine.data?.sections ?? [];
  const sectionId = params.get('section') ?? sections[0]?.id ?? null;
  const rawMonth = params.get('month');
  const month =
    rawMonth && MONTH_RE.test(rawMonth) ? rawMonth : (mine.data?.today.slice(0, 7) ?? null);
  const thisMonth = mine.data?.today.slice(0, 7);

  const setParams = (next: { section?: string; month?: string }) => {
    const q = new URLSearchParams(params);
    if (next.section) q.set('section', next.section);
    if (next.month) q.set('month', next.month);
    router.replace(`${pathname}?${q}`);
  };

  const report = useQuery({
    queryKey: ['attendance-register', tenantId, sectionId, month],
    queryFn: () =>
      client.api<AttendanceRegisterReport>(
        `/attendance/reports/register?${new URLSearchParams({ sectionId: sectionId!, month: month! })}`,
      ),
    enabled: Boolean(sectionId && month),
  });

  const [csvError, setCsvError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const sectionName = (s: { name: string; classLevel: { nameBn: string; nameEn: string } }) =>
    `${displayName(s.classLevel.nameBn, s.classLevel.nameEn, locale)}, ${s.name}`;

  async function downloadCsv() {
    if (!sectionId || !month || !report.data) return;
    setCsvError(false);
    setDownloading(true);
    try {
      const blob = await client.download(
        `/attendance/reports/register/csv?${new URLSearchParams({ sectionId, month, locale })}`,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sectionName(report.data.section)
        .replace(/[\\/:*?"<>|,]+/g, ' ')
        .trim()} ${month}.csv`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      setCsvError(true);
    } finally {
      setDownloading(false);
    }
  }

  if (mine.isPending) {
    return (
      <Skeleton className="h-64 rounded-xl" aria-busy="true" aria-label={tCommon('loading')} />
    );
  }
  if (mine.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{describe(mine.error)}</AlertDescription>
      </Alert>
    );
  }
  if (sections.length === 0) {
    return <p className="text-muted-foreground">{tAtt('noSections', { section: sectionLabel })}</p>;
  }

  const items = sections.map((s) => ({ value: s.id, label: sectionName(s) }));
  const r = report.data;
  const codes = REGISTER_CODES[locale];
  const weekdayNames = t('weekdays').split(',');
  // ISO weekday (1 = Monday) → the Saturday-first short names.
  const weekdayShort = (iso: number) => weekdayNames[(iso + 1) % 7]!;

  return (
    <div className="print-area flex flex-col gap-4" data-testid="register-report">
      <div className="flex flex-col gap-1 print:hidden">
        <h2 className="text-xl font-semibold sm:text-2xl">{t('registerTitle')}</h2>
      </div>

      <div className="flex flex-col gap-3 print:hidden sm:flex-row sm:flex-wrap sm:items-center">
        <Select
          items={items}
          value={sectionId}
          onValueChange={(v) => v && setParams({ section: v })}
        >
          <SelectTrigger
            className="w-full sm:w-64"
            aria-label={t('pickSection', { section: sectionLabel })}
            data-testid="register-section"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((i) => (
              <SelectItem key={i.value} value={i.value}>
                {i.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {month && (
          <div className="flex items-center gap-1" role="group" aria-label={t('month')}>
            <Button
              variant="outline"
              size="icon"
              aria-label={t('prevMonth')}
              onClick={() => setParams({ month: addMonths(month, -1) })}
            >
              <ChevronLeftIcon aria-hidden />
            </Button>
            <span
              className="min-w-36 px-2 text-center font-medium"
              aria-live="polite"
              data-testid="register-month"
            >
              {formatMonth(month, locale)}
            </span>
            <Button
              variant="outline"
              size="icon"
              aria-label={t('nextMonth')}
              disabled={!!thisMonth && month >= thisMonth}
              onClick={() => setParams({ month: addMonths(month, 1) })}
            >
              <ChevronRightIcon aria-hidden />
            </Button>
          </div>
        )}

        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Button
            variant="outline"
            onClick={() => void downloadCsv()}
            disabled={!r || downloading}
            data-testid="register-csv"
          >
            <DownloadIcon aria-hidden />
            {t('downloadCsv')}
          </Button>
          <Button variant="outline" onClick={() => window.print()} disabled={!r}>
            <PrinterIcon aria-hidden />
            {t('print')}
          </Button>
        </div>
      </div>
      {csvError && (
        <Alert variant="destructive" className="print:hidden">
          <AlertDescription>{t('csvFailed')}</AlertDescription>
        </Alert>
      )}

      {report.isPending ? (
        <Skeleton className="h-72 rounded-xl" />
      ) : report.isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            {describe(report.error)}
            <Button size="sm" variant="outline" onClick={() => void report.refetch()}>
              {tCommon('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        r && (
          <>
            {/* Print heading: the paper register's title block. */}
            <div className="hidden print:block">
              <p className="text-lg font-semibold">{context?.tenant.name}</p>
              <p>
                {sectionName(r.section)}, {formatMonth(r.month, locale)}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <p className="text-muted-foreground text-sm">
                {r.daysTaken === 0
                  ? t('noDays')
                  : t('daysTaken', { count: formatCount(r.daysTaken, locale) })}
              </p>
              <ul
                className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
                aria-label={t('legend')}
              >
                {STATUSES.map((s) => (
                  <li key={s} className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className={cn(
                        'inline-flex size-6 items-center justify-center rounded text-xs font-semibold',
                        STATUS_TONE[s],
                      )}
                    >
                      {codes[s]}
                    </span>
                    {tAtt(`status${s}`)}
                  </li>
                ))}
                <li className="flex items-center gap-1.5">
                  <span aria-hidden className="bg-muted register-off inline-block size-6 rounded" />
                  {t('offDay')}
                </li>
              </ul>
            </div>

            {r.rows.length === 0 ? (
              <div className="bg-card flex flex-col items-center gap-2 rounded-xl border px-6 py-10 text-center">
                <TableIcon aria-hidden className="text-muted-foreground size-7" />
                <p>{t('noStudents', { section: sectionLabel })}</p>
              </div>
            ) : (
              <div
                className="bg-card overflow-x-auto rounded-xl border shadow-xs print:overflow-visible print:rounded-none print:border-0 print:shadow-none"
                data-testid="register-table"
              >
                <table className="register-table w-max min-w-full border-separate border-spacing-0 text-sm">
                  <thead>
                    <tr>
                      <th
                        scope="col"
                        className="bg-card sticky left-0 z-10 border-r border-b px-3 py-2 text-left font-medium"
                      >
                        {t('colName')}
                      </th>
                      {r.days.map((d) => (
                        <th
                          key={d.date}
                          scope="col"
                          title={
                            d.nonWorkingDay?.reason === 'HOLIDAY'
                              ? locale === 'bn'
                                ? d.nonWorkingDay.nameBn
                                : d.nonWorkingDay.nameEn
                              : undefined
                          }
                          className={cn(
                            'w-8 min-w-8 border-b px-0.5 py-1 text-center font-normal',
                            d.nonWorkingDay && 'bg-muted register-off',
                          )}
                        >
                          <span className="font-numeric block font-medium">
                            {formatCount(Number(d.date.slice(8)), locale)}
                          </span>
                          <span className="text-muted-foreground block text-[0.7rem] leading-tight">
                            {weekdayShort(d.weekday)}
                          </span>
                        </th>
                      ))}
                      {STATUSES.map((s) => (
                        <th
                          key={s}
                          scope="col"
                          title={tAtt(`status${s}`)}
                          className="w-9 min-w-9 border-b border-l px-1 py-1 text-center font-medium"
                        >
                          {codes[s]}
                        </th>
                      ))}
                      <th
                        scope="col"
                        className="border-b border-l px-2 py-1 text-center font-medium"
                      >
                        {t('colPercent')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.rows.map((row) => {
                      const name = displayName(row.nameBn, row.nameEn, locale);
                      return (
                        <tr key={row.id} className="group">
                          <th
                            scope="row"
                            className="bg-card group-hover:bg-muted sticky left-0 z-10 w-40 max-w-40 min-w-40 border-r border-b px-2 py-1 text-left font-normal sm:w-56 sm:max-w-56 sm:min-w-56"
                          >
                            <Link
                              href={`/attendance/students/${row.id}?${new URLSearchParams({ from: r.days[0]!.date, to: r.days.at(-1)!.date })}`}
                              // 44 px tall on touch screens (control-h-xs), as before on a desk.
                              className="flex min-h-(--control-h-xs) items-center gap-2 hover:underline"
                            >
                              <span className="text-muted-foreground w-6 shrink-0 text-xs tabular-nums">
                                {row.roll != null ? formatIdentifier(row.roll) : ''}
                              </span>
                              <span className="line-clamp-2 min-w-0 leading-snug break-words">
                                {name}
                              </span>
                            </Link>
                          </th>
                          {r.days.map((d) => {
                            const s = row.cells[d.date];
                            return (
                              <td
                                key={d.date}
                                className={cn(
                                  'border-b p-0.5 text-center',
                                  d.nonWorkingDay && 'bg-muted register-off',
                                )}
                              >
                                {s ? (
                                  <span
                                    className={cn(
                                      'inline-flex size-7 items-center justify-center rounded text-xs font-semibold',
                                      STATUS_TONE[s],
                                    )}
                                    title={tAtt(`status${s}`)}
                                  >
                                    {codes[s]}
                                  </span>
                                ) : null}
                              </td>
                            );
                          })}
                          {(['present', 'absent', 'late', 'leave'] as const).map((k) => (
                            <td key={k} className="font-numeric border-b border-l px-1 text-center">
                              {formatCount(row.counts[k], locale)}
                            </td>
                          ))}
                          <td className="font-numeric border-b border-l px-2 text-center font-semibold">
                            {row.percent === null
                              ? '—'
                              : formatCount(Math.round(row.percent), locale)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th
                        scope="row"
                        className="bg-card sticky left-0 z-10 border-r px-3 py-2 text-left font-medium"
                      >
                        {t('dayPresent')}
                      </th>
                      {r.days.map((d) => {
                        const c = r.dayTotals[d.date];
                        return (
                          <td
                            key={d.date}
                            className={cn(
                              'font-numeric px-0.5 text-center text-xs',
                              d.nonWorkingDay && 'bg-muted register-off',
                            )}
                          >
                            {c ? formatCount(c.present + c.late, locale) : ''}
                          </td>
                        );
                      })}
                      {(['present', 'absent', 'late', 'leave'] as const).map((k) => (
                        <td key={k} className="font-numeric border-l px-1 text-center font-medium">
                          {formatCount(r.totals.counts[k], locale)}
                        </td>
                      ))}
                      <td className="font-numeric border-l px-2 text-center font-semibold">
                        {r.totals.percent === null
                          ? '—'
                          : formatCount(Math.round(r.totals.percent), locale)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}

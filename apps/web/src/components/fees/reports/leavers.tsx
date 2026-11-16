'use client';

import { useQuery } from '@tanstack/react-query';
import {
  formatCount,
  formatDate,
  formatIdentifier,
  formatTaka,
  type FeeLeaverRow,
  type FeeLeaversReport,
} from '@jantrik/shared';
import { CircleCheckIcon, DownloadIcon, PrinterIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { DataTable, type DataColumn } from '@/components/data-table';
import { Pill } from '@/components/kit/pill';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick } from '@/lib/fees';
import { useLabel } from '@/lib/hooks';
import { useMediaQuery } from '@/lib/media';
import { downloadFile, EmptyState, LoadError, PhoneText } from './kit';

/**
 * Leavers with dues (P5-K, docs/fees.md → Reports): students who still owe but are not on the
 * due list: leavers, students not carried over into the current year, deactivated students.
 * Their dues never move (S17); this is where they are followed up. CSV and print as the others.
 */
export function LeaversReport() {
  const t = useTranslations('fees.reports.leavers');
  const tc = useTranslations('fees.reports.common');
  const tStatus = useTranslations('studentStatus');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const { client, session } = useAuth();
  const wide = useMediaQuery('(min-width: 768px)');
  const report = useQuery({
    queryKey: ['fees', session?.tenant?.id, 'reports', 'leavers'],
    queryFn: () => client.api<FeeLeaversReport>('/fees/reports/leavers-with-dues'),
  });
  const [csvFailed, setCsvFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const taka = (p: number) => formatTaka(p, locale);
  const name = (r: FeeLeaverRow) =>
    pick(locale, r.student) || formatIdentifier(r.student.studentCode);
  const place = (r: FeeLeaverRow) =>
    [r.lastYear?.name, r.classLevel && pick(locale, r.classLevel), r.section?.name]
      .filter(Boolean)
      .join(' · ');
  const kind = (r: FeeLeaverRow) =>
    r.kind === 'LEFT'
      ? r.leftOn
        ? t('leftOn', { status: tStatus(r.status), date: formatDate(r.leftOn, locale) })
        : tStatus(r.status)
      : t(`kind.${r.kind}`);

  const downloadCsv = async () => {
    setCsvFailed(false);
    setDownloading(true);
    try {
      await downloadFile(
        client,
        `/fees/reports/leavers-with-dues/csv?locale=${locale}`,
        `leavers-with-dues-${report.data?.today ?? ''}.csv`,
      );
    } catch {
      setCsvFailed(true);
    } finally {
      setDownloading(false);
    }
  };

  const columns: DataColumn<FeeLeaverRow>[] = [
    {
      id: 'student',
      header: t('student'),
      cell: (r) => (
        <span className="flex flex-col">
          <span className="font-medium">{name(r)}</span>
          <span className="text-muted-foreground text-xs tabular-nums" dir="ltr">
            {formatIdentifier(r.student.studentCode)}
          </span>
        </span>
      ),
    },
    {
      id: 'kind',
      header: t('why'),
      cell: (r) => <Pill tone={r.kind === 'DEACTIVATED' ? 'neutral' : 'warning'}>{kind(r)}</Pill>,
    },
    {
      id: 'last',
      header: `${t('lastYear')} · ${label('class_level', 'Class')} · ${label('section', 'Section')}`,
      cell: (r) => place(r) || '—',
    },
    {
      id: 'guardian',
      header: t('guardian'),
      cell: (r) =>
        r.guardian ? (
          <span className="flex flex-col">
            <span>{pick(locale, r.guardian)}</span>
            <PhoneText phone={r.guardian.phone} className="text-muted-foreground text-xs" />
          </span>
        ) : (
          '—'
        ),
    },
    {
      id: 'total',
      header: t('total'),
      align: 'end',
      className: 'font-semibold',
      cell: (r) => taka(r.totalPaisa),
    },
    {
      id: 'overdue',
      header: t('overdue'),
      align: 'end',
      cell: (r) =>
        r.overduePaisa > 0 ? <span className="text-destructive">{taka(r.overduePaisa)}</span> : '—',
    },
  ];

  if (report.isPending) return <Skeleton className="h-64 rounded-xl" />;
  if (report.isError)
    return <LoadError error={report.error} onRetry={() => void report.refetch()} />;
  const data = report.data;
  return (
    <div className="flex flex-col gap-(--gap)" data-testid="leavers-report">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <p className="text-muted-foreground text-sm">{t('intro')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => void downloadCsv()}
            disabled={downloading || data.rows.length === 0}
            data-testid="leavers-csv"
          >
            <DownloadIcon aria-hidden />
            {tc('csv')}
          </Button>
          <Button
            variant="outline"
            onClick={() => window.print()}
            disabled={data.rows.length === 0}
          >
            <PrinterIcon aria-hidden />
            {tc('print')}
          </Button>
        </div>
      </div>
      {csvFailed && (
        <Alert variant="destructive">
          <AlertDescription>{tc('csvFailed')}</AlertDescription>
        </Alert>
      )}
      {data.rows.length === 0 ? (
        <EmptyState icon={CircleCheckIcon} title={t('empty')} hint={t('emptyHint')} />
      ) : wide ? (
        <DataTable
          columns={columns}
          rows={data.rows}
          rowKey={(r) => r.student.id}
          rowLabel={name}
          testId="leavers-table"
          footer={
            <tr className="font-semibold">
              <td colSpan={4} className="px-3 py-2">
                {t('totalRow', {
                  count: formatCount(data.totals.students, locale),
                  n: data.totals.students,
                })}
              </td>
              <td className="px-3 py-2 text-end">{taka(data.totals.totalPaisa)}</td>
              <td className="px-3 py-2 text-end">
                {data.totals.overduePaisa > 0 ? taka(data.totals.overduePaisa) : '—'}
              </td>
            </tr>
          }
        />
      ) : (
        <ul
          className="bg-card rounded-card flex flex-col divide-y border"
          data-testid="leavers-cards"
        >
          {data.rows.map((r) => (
            <li key={r.student.id} className="flex flex-col gap-1.5 px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                  <span className="font-semibold break-words">{name(r)}</span>
                  <span className="text-muted-foreground text-sm">{place(r) || '—'}</span>
                </div>
                <span className="font-numeric shrink-0 text-lg font-semibold">
                  {taka(r.totalPaisa)}
                </span>
              </div>
              <span>
                <Pill tone={r.kind === 'DEACTIVATED' ? 'neutral' : 'warning'}>{kind(r)}</Pill>
              </span>
              {r.guardian && (
                <span className="text-muted-foreground flex flex-wrap gap-1.5 text-sm">
                  {pick(locale, r.guardian)} · <PhoneText phone={r.guardian.phone} />
                </span>
              )}
            </li>
          ))}
          <li className="flex justify-between px-3 py-3 font-semibold">
            <span>
              {t('totalRow', {
                count: formatCount(data.totals.students, locale),
                n: data.totals.students,
              })}
            </span>
            <span className="font-numeric">{taka(data.totals.totalPaisa)}</span>
          </li>
        </ul>
      )}
    </div>
  );
}

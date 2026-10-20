'use client';

import {
  addMonths,
  formatCount,
  formatDate,
  formatMonth,
  formatTaka,
  todayIn,
  type PlatformSmsTotals,
  type PlatformUsage,
  type PlatformUsageInstitute,
} from '@jantrik/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Building2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GraduationCapIcon,
  KeyRoundIcon,
  MessageSquareTextIcon,
  WalletIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { SelectField } from '@/components/form-kit';
import { InstituteStatusBadge, usePlatformError } from '@/components/platform/institute-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { platformApi } from '@/lib/platform/platform-api';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 25;

/** Usage and cost for a month: totals, then institutes by what their SMS cost. Counts only. */
export default function PlatformUsagePage() {
  const t = useTranslations('platformUsage');
  const locale = useLocale() as Locale;
  const explain = usePlatformError();
  const thisMonth = todayIn('Asia/Dhaka').slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [paging, setPaging] = useState({ month, page: 1 });
  const page = paging.month === month ? paging.page : 1;
  const q = useQuery({
    queryKey: ['platform-usage', month, page],
    queryFn: () =>
      platformApi<PlatformUsage>(
        `/platform/usage?month=${month}&page=${page}&pageSize=${PAGE_SIZE}`,
      ),
    placeholderData: keepPreviousData,
  });
  const months = Array.from({ length: 12 }, (_, i) => addMonths(thisMonth, -i));
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground max-w-prose">{t('hint')}</p>
        </div>
        <SelectField
          id="usage-month"
          label={t('month')}
          value={month}
          onChange={setMonth}
          className="w-full sm:w-56"
          options={months.map((m) => ({ value: m, label: formatMonth(m, locale) }))}
        />
      </div>
      {q.isPending ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : q.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{explain(q.error)}</AlertDescription>
        </Alert>
      ) : (
        <>
          <Totals u={q.data} locale={locale} />
          <section className="flex flex-col gap-3" aria-labelledby="usage-institutes-title">
            <h2 id="usage-institutes-title" className="text-lg font-semibold">
              {t('perInstitute')}
            </h2>
            <UsageCards items={q.data.items} locale={locale} />
            <UsageTable items={q.data.items} locale={locale} />
            <Pager u={q.data} locale={locale} onPage={(p) => setPaging({ month, page: p })} />
          </section>
        </>
      )}
    </div>
  );
}

function Totals({ u, locale }: { u: PlatformUsage; locale: Locale }) {
  const t = useTranslations('platformUsage');
  const sms = (s: PlatformSmsTotals) =>
    t('smsLine', {
      count: formatCount(s.count, locale),
      segments: formatCount(s.segments, locale),
    });
  const cards = [
    {
      id: 'usage-total',
      icon: WalletIcon,
      label: t('totalCost'),
      value: formatTaka(u.totalCostPaisa, locale),
      note: t('rateNow', { rate: formatTaka(u.smsCostPerSegmentPaisa, locale) }),
    },
    {
      id: 'usage-institutes-sms',
      icon: MessageSquareTextIcon,
      label: t('institutesSms'),
      value: formatTaka(u.institutesSms.costPaisa, locale),
      note: sms(u.institutesSms),
    },
    {
      id: 'usage-login-sms',
      icon: KeyRoundIcon,
      label: t('loginSms'),
      value: formatTaka(u.loginSms.costPaisa, locale),
      note: sms(u.loginSms),
    },
    {
      id: 'usage-students',
      icon: GraduationCapIcon,
      label: t('activeStudents'),
      value: formatCount(u.activeStudents, locale),
      note: t('institutesLine', {
        total: formatCount(u.institutes.total, locale),
        active: formatCount(u.institutes.active, locale),
        trial: formatCount(u.institutes.trial, locale),
        suspended: formatCount(u.institutes.suspended, locale),
      }),
    },
  ];
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="usage-totals">
      {cards.map((c) => (
        <li
          key={c.id}
          className="bg-card flex flex-col gap-2 rounded-xl border p-4 shadow-xs"
          data-testid={c.id}
        >
          <span className="text-muted-foreground flex items-center gap-2 text-sm">
            <span className="bg-primary-soft text-primary flex size-8 items-center justify-center rounded-lg">
              <c.icon aria-hidden className="size-4" />
            </span>
            {c.label}
          </span>
          <span className="font-numeric text-3xl font-semibold">{c.value}</span>
          <span className="text-muted-foreground text-sm">{c.note}</span>
        </li>
      ))}
      <li className="text-muted-foreground text-sm sm:col-span-2 xl:col-span-4">
        {t('rateNote')}{' '}
        <Link href="/platform/settings" className="text-primary underline-offset-2 hover:underline">
          {t('changeRate')}
        </Link>
      </li>
    </ul>
  );
}

type ListProps = { items: PlatformUsageInstitute[]; locale: Locale };

function UsageCards({ items, locale }: ListProps) {
  const t = useTranslations('platformUsage');
  return (
    <ul className="flex flex-col gap-3 lg:hidden" data-testid="usage-cards">
      {items.map((i) => (
        <li key={i.id} className="bg-card flex flex-col gap-2 rounded-xl border p-4 shadow-xs">
          <div className="flex items-start justify-between gap-3">
            <Link
              href={`/platform/institutes/${i.id}`}
              className="font-semibold break-words underline-offset-2 hover:underline"
            >
              {i.name}
            </Link>
            <InstituteStatusBadge status={i.status} />
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('cost')}</dt>
            <dd className="font-numeric text-right font-semibold">
              {formatTaka(i.smsCostPaisa, locale)}
            </dd>
            <dt className="text-muted-foreground">{t('smsSent')}</dt>
            <dd className="font-numeric text-right">
              {t('smsLine', {
                count: formatCount(i.smsSent, locale),
                segments: formatCount(i.smsSegments, locale),
              })}
            </dd>
            <dt className="text-muted-foreground">{t('students')}</dt>
            <dd className="font-numeric text-right">{formatCount(i.activeStudents, locale)}</dd>
            <dt className="text-muted-foreground">{t('imports')}</dt>
            <dd className="font-numeric text-right">{formatCount(i.importsThisMonth, locale)}</dd>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function UsageTable({ items, locale }: ListProps) {
  const t = useTranslations('platformUsage');
  const th =
    'text-muted-foreground h-11 border-b px-4 text-left text-sm font-medium whitespace-nowrap first:pl-5';
  return (
    <div className="bg-card hidden overflow-clip rounded-xl border shadow-xs lg:block">
      <table className="w-full text-sm" data-testid="usage-table">
        <thead>
          <tr>
            <th className={th}>{t('institute')}</th>
            <th className={th}>{t('status')}</th>
            <th className={cn(th, 'text-right')}>{t('students')}</th>
            <th className={cn(th, 'text-right')}>{t('smsSent')}</th>
            <th className={cn(th, 'text-right')}>{t('segments')}</th>
            <th className={cn(th, 'text-right')}>{t('cost')}</th>
            <th className={cn(th, 'text-right')}>{t('imports')}</th>
            <th className={th}>{t('lastActivity')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id} className="border-b last:border-b-0">
              <td className="py-3 pr-4 pl-5">
                <Link
                  href={`/platform/institutes/${i.id}`}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {i.name}
                </Link>
              </td>
              <td className="px-4 py-3">
                <InstituteStatusBadge status={i.status} />
              </td>
              <td className="font-numeric px-4 py-3 text-right">
                {formatCount(i.activeStudents, locale)}
              </td>
              <td className="font-numeric px-4 py-3 text-right">
                {formatCount(i.smsSent, locale)}
              </td>
              <td className="font-numeric px-4 py-3 text-right">
                {formatCount(i.smsSegments, locale)}
              </td>
              <td className="font-numeric px-4 py-3 text-right font-semibold">
                {formatTaka(i.smsCostPaisa, locale)}
              </td>
              <td className="font-numeric px-4 py-3 text-right">
                {formatCount(i.importsThisMonth, locale)}
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                {i.lastActivityAt ? formatDate(new Date(i.lastActivityAt), locale, 'medium') : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pager({
  u,
  locale,
  onPage,
}: {
  u: PlatformUsage;
  locale: Locale;
  onPage: (page: number) => void;
}) {
  const t = useTranslations('platformUsage');
  const last = Math.max(1, Math.ceil(u.total / u.pageSize));
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Building2Icon aria-hidden className="size-4" />
        {t('count', { count: formatCount(u.total, locale), n: u.total })}
      </p>
      {last > 1 && (
        <div className="flex gap-2">
          <Button variant="outline" disabled={u.page <= 1} onClick={() => onPage(u.page - 1)}>
            <ChevronLeftIcon aria-hidden />
            {t('previous')}
          </Button>
          <Button variant="outline" disabled={u.page >= last} onClick={() => onPage(u.page + 1)}>
            {t('next')}
            <ChevronRightIcon aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}

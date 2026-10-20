'use client';

import {
  INSTITUTE_STATUS_VALUES,
  formatBdPhone,
  formatCount,
  formatDate,
  type PlatformInstituteListItem,
  type PlatformInstituteOptions,
  type PlatformInstitutePage,
} from '@jantrik/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Building2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  SearchIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { SelectField } from '@/components/form-kit';
import { InstituteStatusBadge, OwnerStatusBadge } from '@/components/platform/institute-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useDebounced, useErrorMessage } from '@/lib/hooks';
import { platformApi } from '@/lib/platform/platform-api';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 25;

/** Every institute: filters, then cards on phones and a table on desktop. Metadata only. */
export default function PlatformInstitutesPage() {
  const t = useTranslations('platformInstitutes');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search.trim(), 300);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [plan, setPlan] = useState('');
  const [trialEnded, setTrialEnded] = useState(false);
  // The page belongs to one set of filters: any change starts again at page 1.
  const filterKey = JSON.stringify([debounced, type, status, plan, trialEnded]);
  const [paging, setPaging] = useState({ key: filterKey, page: 1 });
  const page = paging.key === filterKey ? paging.page : 1;
  const setPage = (next: number) => setPaging({ key: filterKey, page: next });

  const options = useQuery({
    queryKey: ['platform-institute-options'],
    queryFn: () => platformApi<PlatformInstituteOptions>('/platform/institutes/options'),
    staleTime: 5 * 60_000,
  });
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (debounced) params.set('search', debounced);
  if (type) params.set('type', type);
  if (status) params.set('status', status);
  if (plan) params.set('plan', plan);
  if (trialEnded) params.set('trialEnded', 'true');
  const list = useQuery({
    queryKey: ['platform-institutes', params.toString()],
    queryFn: () => platformApi<PlatformInstitutePage>(`/platform/institutes?${params}`),
    placeholderData: keepPreviousData,
  });
  const filtered = Boolean(debounced || type || status || plan || trialEnded);
  const typeName = (key: string) => {
    const found = options.data?.types.find((x) => x.key === key);
    return found ? (locale === 'bn' ? found.nameBn : found.nameEn) : key;
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground">{t('hint')}</p>
        </div>
        <ButtonLink href="/platform/institutes/new" data-testid="add-institute">
          <PlusIcon aria-hidden />
          {t('add')}
        </ButtonLink>
      </div>

      <div
        className="bg-card grid gap-3 rounded-xl border p-4 shadow-xs sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto] lg:items-end"
        data-testid="institute-filters"
      >
        <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2 lg:col-span-1">
          <Label htmlFor="institute-search">{t('search')}</Label>
          <div className="relative">
            <SearchIcon
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            />
            <Input
              id="institute-search"
              type="search"
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('searchPlaceholder')}
              data-testid="institute-search"
            />
          </div>
        </div>
        <SelectField
          id="institute-type"
          label={t('type')}
          value={type}
          onChange={setType}
          placeholder={t('anyType')}
          options={(options.data?.types ?? []).map((x) => ({
            value: x.key,
            label: locale === 'bn' ? x.nameBn : x.nameEn,
          }))}
        />
        <SelectField
          id="institute-status"
          label={t('status')}
          value={status}
          onChange={setStatus}
          placeholder={t('anyStatus')}
          options={INSTITUTE_STATUS_VALUES.map((s) => ({ value: s, label: t(`status_${s}`) }))}
        />
        <SelectField
          id="institute-plan"
          label={t('plan')}
          value={plan}
          onChange={setPlan}
          placeholder={t('anyPlan')}
          options={(options.data?.plans ?? []).map((p) => ({ value: p, label: p }))}
        />
        <label className="flex h-11 items-center gap-2 text-sm font-medium md:h-10">
          <input
            type="checkbox"
            className="accent-primary size-5"
            checked={trialEnded}
            onChange={(e) => setTrialEnded(e.target.checked)}
            data-testid="filter-trial-ended"
          />
          {t('trialEndedOnly')}
        </label>
      </div>

      {list.isPending ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : list.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{describe(list.error)}</AlertDescription>
        </Alert>
      ) : list.data.items.length === 0 ? (
        <Empty filtered={filtered} />
      ) : (
        <>
          <InstituteCards items={list.data.items} locale={locale} typeName={typeName} />
          <InstituteTable items={list.data.items} locale={locale} typeName={typeName} />
          <Pager page={list.data} onPage={setPage} locale={locale} />
        </>
      )}
    </div>
  );
}

function Empty({ filtered }: { filtered: boolean }) {
  const t = useTranslations('platformInstitutes');
  return (
    <div
      className="bg-card flex flex-col items-center gap-3 rounded-xl border px-4 py-10 text-center"
      data-testid="institutes-empty"
    >
      <span className="bg-primary-soft text-primary flex size-12 items-center justify-center rounded-lg">
        <Building2Icon aria-hidden className="size-6" />
      </span>
      <p className="font-medium">{filtered ? t('emptyFiltered') : t('emptyAll')}</p>
      <p className="text-muted-foreground max-w-prose text-sm">
        {filtered ? t('emptyFilteredHint') : t('emptyAllHint')}
      </p>
      {!filtered && (
        <ButtonLink href="/platform/institutes/new">
          <PlusIcon aria-hidden />
          {t('add')}
        </ButtonLink>
      )}
    </div>
  );
}

type ListProps = {
  items: PlatformInstituteListItem[];
  locale: Locale;
  typeName: (key: string) => string;
};

function OwnerLine({ owner }: { owner: PlatformInstituteListItem['owner'] }) {
  const t = useTranslations('platformInstitutes');
  const locale = useLocale() as Locale;
  if (!owner) return <span className="text-muted-foreground">{t('noOwner')}</span>;
  const name = (locale === 'bn' ? owner.nameBn : null) ?? owner.name ?? '—';
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <span className="break-words">{name}</span>
        {owner.status !== 'ACTIVE' && <OwnerStatusBadge status={owner.status} />}
      </span>
      {owner.phone && (
        <a
          href={`tel:${owner.phone}`}
          className="text-primary w-fit tabular-nums underline-offset-2 hover:underline"
          dir="ltr"
        >
          {formatBdPhone(owner.phone)}
        </a>
      )}
    </span>
  );
}

function InstituteCards({ items, locale, typeName }: ListProps) {
  const t = useTranslations('platformInstitutes');
  return (
    <ul className="flex flex-col gap-3 lg:hidden" data-testid="institute-cards">
      {items.map((i) => (
        <li key={i.id} className="bg-card flex flex-col gap-3 rounded-xl border p-4 shadow-xs">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Link
                href={`/platform/institutes/${i.id}`}
                className="font-semibold break-words underline-offset-2 hover:underline"
                data-testid="institute-link"
              >
                {i.name}
              </Link>
              <span className="text-muted-foreground text-sm" dir="ltr">
                {i.slug}
              </span>
            </div>
            <InstituteStatusBadge status={i.status} trialEnded={i.trialEnded} />
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <Pair label={t('type')}>{typeName(i.type.key)}</Pair>
            <Pair label={t('plan')}>{i.planName ?? t('noPlan')}</Pair>
            <Pair label={t('colStudents')}>{formatCount(i.activeStudents, locale)}</Pair>
            <Pair label={t('colSms')}>{formatCount(i.smsThisMonth, locale)}</Pair>
            <div className="col-span-2 flex flex-col gap-0.5">
              <dt className="text-muted-foreground">{t('colOwner')}</dt>
              <dd>
                <OwnerLine owner={i.owner} />
              </dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function Pair({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">{children}</dd>
    </div>
  );
}

function InstituteTable({ items, locale, typeName }: ListProps) {
  const t = useTranslations('platformInstitutes');
  const th =
    'text-muted-foreground h-11 border-b px-4 text-left text-sm font-medium whitespace-nowrap first:pl-5';
  return (
    <div className="bg-card hidden overflow-clip rounded-xl border shadow-xs lg:block">
      <table className="w-full text-sm" data-testid="institute-table">
        <thead>
          <tr>
            <th className={th}>{t('colInstitute')}</th>
            <th className={th}>{t('type')}</th>
            <th className={th}>{t('status')}</th>
            <th className={th}>{t('plan')}</th>
            <th className={th}>{t('colOwner')}</th>
            <th className={cn(th, 'text-right')}>{t('colStudents')}</th>
            <th className={cn(th, 'text-right')}>{t('colSms')}</th>
            <th className={th}>{t('colCreated')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr
              key={i.id}
              className="hover:bg-primary-soft/40 border-b align-top transition-colors last:border-b-0"
            >
              <td className="py-3 pr-4 pl-5">
                <span className="flex min-w-0 flex-col">
                  <Link
                    href={`/platform/institutes/${i.id}`}
                    className="font-medium underline-offset-2 hover:underline"
                    data-testid="institute-link"
                  >
                    {i.name}
                  </Link>
                  <span className="text-muted-foreground text-xs" dir="ltr">
                    {i.slug}
                  </span>
                </span>
              </td>
              <td className="px-4 py-3">{typeName(i.type.key)}</td>
              <td className="px-4 py-3">
                <InstituteStatusBadge status={i.status} trialEnded={i.trialEnded} />
              </td>
              <td className="px-4 py-3">
                {i.planName ?? <span className="text-muted-foreground">{t('noPlan')}</span>}
              </td>
              <td className="px-4 py-3">
                <OwnerLine owner={i.owner} />
              </td>
              <td className="font-numeric px-4 py-3 text-right">
                {formatCount(i.activeStudents, locale)}
              </td>
              <td className="font-numeric px-4 py-3 text-right">
                {formatCount(i.smsThisMonth, locale)}
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                {formatDate(new Date(i.createdAt), locale, 'medium')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pager({
  page: p,
  onPage,
  locale,
}: {
  page: PlatformInstitutePage;
  onPage: (page: number) => void;
  locale: Locale;
}) {
  const t = useTranslations('platformInstitutes');
  const from = (p.page - 1) * p.pageSize + 1;
  const to = Math.min(p.page * p.pageSize, p.total);
  const last = Math.max(1, Math.ceil(p.total / p.pageSize));
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-muted-foreground text-sm" data-testid="institutes-count">
        {t('showing', {
          from: formatCount(from, locale),
          to: formatCount(to, locale),
          total: formatCount(p.total, locale),
        })}
      </p>
      {last > 1 && (
        <div className="flex gap-2">
          <Button variant="outline" disabled={p.page <= 1} onClick={() => onPage(p.page - 1)}>
            <ChevronLeftIcon aria-hidden />
            {t('previous')}
          </Button>
          <Button variant="outline" disabled={p.page >= last} onClick={() => onPage(p.page + 1)}>
            {t('next')}
            <ChevronRightIcon aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}

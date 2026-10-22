'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  daysBetween,
  formatCount,
  formatDate,
  formatIdentifier,
  formatTaka,
  type FeeDueList,
  type FeeDueListRow,
} from '@jantrik/shared';
import {
  BellRingIcon,
  CircleCheckIcon,
  DownloadIcon,
  PhoneIcon,
  PrinterIcon,
  SearchXIcon,
  XIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { DataTable, type DataColumn, type SortState } from '@/components/data-table';
import { MoneyField } from '@/components/fees/money-field';
import { SelectField } from '@/components/form-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick, useFeeRoles } from '@/lib/fees';
import { useLabel, useMeContext } from '@/lib/hooks';
import { useMediaQuery } from '@/lib/media';
import { cn } from '@/lib/utils';
import { useUrlParams } from '@/lib/view-state';
import {
  downloadFile,
  EmptyState,
  intParam,
  isDialable,
  LoadError,
  PhoneText,
  useMinDaysOptions,
} from './kit';

/*
 * Who owes what (docs/fees.md → Reports): the due list, and the defaulters (overdue for at
 * least N days and M taka). Filters live in the URL. The whole list comes once and is filtered
 * by class and section here, so the choices are the classes that actually owe (and the
 * accountant, who cannot read the institute's setup, gets them too); the CSV is filtered by
 * the API with the same rules. A table with totals in its footer from 768 px, cards on phones.
 */

type SortKey = 'class' | 'total' | 'overdue' | 'fine' | 'days';
const SORT_KEYS: readonly SortKey[] = ['class', 'total', 'overdue', 'fine', 'days'];
/** Phones draw cards a page at a time (a big school owes in hundreds of rows). */
const CARD_PAGE = 50;

type Column = DataColumn<FeeDueListRow> & { foot?: ReactNode };

/** Overdue days: from the oldest overdue due date to today. */
const overdueDays = (row: FeeDueListRow, today: string) =>
  row.oldestOverdue ? Math.max(0, daysBetween(row.oldestOverdue, today)) : 0;

/** "500" or "500.5" taka in the URL → paisa (0 when absent or not an amount). */
const takaParam = (v: string | null) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 && n <= 10_000_000 ? Math.round(n * 100) : 0;
};

export function DueListReport({ mode }: { mode: 'dues' | 'defaulters' }) {
  const t = useTranslations('fees.reports.dues');
  const tc = useTranslations('fees.reports.common');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  const { data: context } = useMeContext();
  const { manages } = useFeeRoles();
  const wide = useMediaQuery('(min-width: 768px)');
  const id = useId();
  const defaulters = mode === 'defaulters';

  const { params, set } = useUrlParams();
  const minDays = defaulters ? intParam(params.get('days'), 1, 1, 3650) : 0;
  const minAmountPaisa = defaulters ? takaParam(params.get('min')) : 0;
  const sortParam = params.get('sort');
  const sortKey: SortKey =
    sortParam && (SORT_KEYS as readonly string[]).includes(sortParam)
      ? (sortParam as SortKey)
      : 'class';
  const dir = params.get('dir') === 'desc' ? 'desc' : 'asc';

  const apiQuery = new URLSearchParams({ locale });
  if (defaulters) {
    apiQuery.set('overdueOnly', '1');
    apiQuery.set('minDays', String(minDays));
    if (minAmountPaisa > 0) apiQuery.set('minAmountPaisa', String(minAmountPaisa));
  }
  const report = useQuery({
    queryKey: ['fee-due-list', tenantId, apiQuery.toString()],
    queryFn: () => client.api<FeeDueList>(`/fees/reports/dues?${apiQuery}`),
    placeholderData: keepPreviousData,
  });
  const allRows = report.data?.rows ?? [];
  const today = report.data?.today ?? context?.today ?? '';

  // The classes and sections that appear, in the API's order (class, then section).
  const classes: { id: string; name: string; sections: { id: string; name: string }[] }[] = [];
  for (const r of allRows) {
    if (!r.classLevel) continue;
    let c = classes.find((x) => x.id === r.classLevel!.id);
    if (!c) {
      c = { id: r.classLevel.id, name: pick(locale, r.classLevel), sections: [] };
      classes.push(c);
    }
    if (r.section && !c.sections.some((s) => s.id === r.section!.id)) c.sections.push(r.section);
  }
  const chosenClass = classes.find((c) => c.id === params.get('class')) ?? null;
  const chosenSection = chosenClass?.sections.find((s) => s.id === params.get('section')) ?? null;
  const filtered = Boolean(chosenClass);

  const rows = allRows.filter(
    (r) =>
      (!chosenClass || r.classLevel?.id === chosenClass.id) &&
      (!chosenSection || r.section?.id === chosenSection.id),
  );
  const sorted =
    sortKey === 'class'
      ? dir === 'asc'
        ? rows
        : [...rows].reverse()
      : [...rows].sort((a, b) => {
          const v = (r: FeeDueListRow) =>
            sortKey === 'total'
              ? r.totalPaisa
              : sortKey === 'overdue'
                ? r.overduePaisa
                : sortKey === 'fine'
                  ? r.finePaisa
                  : overdueDays(r, today);
          return dir === 'asc' ? v(a) - v(b) : v(b) - v(a);
        });
  const sum = (k: 'principalPaisa' | 'finePaisa' | 'totalPaisa' | 'overduePaisa') =>
    rows.reduce((s, r) => s + r[k], 0);
  const totals = {
    principal: sum('principalPaisa'),
    fine: sum('finePaisa'),
    total: sum('totalPaisa'),
    overdue: sum('overduePaisa'),
  };

  // The minimum amount is typed ahead of the URL and written after a pause.
  const [minDraft, setMinDraft] = useState<number | null>(minAmountPaisa || null);
  const typing = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(typing.current), []);
  const onMinAmount = (paisa: number | null) => {
    setMinDraft(paisa);
    clearTimeout(typing.current);
    typing.current = setTimeout(
      () => set({ min: paisa && paisa > 0 ? String(paisa / 100) : null }),
      500,
    );
  };

  const [csvFailed, setCsvFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const downloadCsv = async () => {
    setCsvFailed(false);
    setDownloading(true);
    const q = new URLSearchParams(apiQuery);
    if (chosenClass) q.set('classLevelId', chosenClass.id);
    if (chosenSection) q.set('sectionId', chosenSection.id);
    try {
      await downloadFile(client, `/fees/reports/dues/csv?${q}`, `${mode}-${today}.csv`);
    } catch {
      setCsvFailed(true);
    } finally {
      setDownloading(false);
    }
  };

  const classLabel = label('class_level', 'Class');
  const sectionLabel = label('section', 'Section');
  const daysOptions = useMinDaysOptions(minDays);
  const [shown, setShown] = useState(CARD_PAGE);
  const f = (n: number) => formatCount(n, locale);
  const taka = (p: number) => formatTaka(p, locale);
  const name = (r: FeeDueListRow) =>
    pick(locale, r.student) || formatIdentifier(r.student.studentCode);
  const place = (r: FeeDueListRow) =>
    [r.classLevel && pick(locale, r.classLevel), r.section?.name].filter(Boolean).join(' · ');

  const columns: Column[] = [
    {
      id: 'student',
      header: t('student'),
      cell: (r) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{name(r)}</span>
          <span className="text-muted-foreground text-xs tabular-nums" dir="ltr">
            {formatIdentifier(r.student.studentCode)}
          </span>
        </span>
      ),
      foot: t('totalRow', { count: f(rows.length), n: rows.length }),
    },
    {
      id: 'class',
      header: `${classLabel} · ${sectionLabel}`,
      sortKey: 'class',
      cell: (r) => place(r) || '—',
    },
    {
      id: 'roll',
      header: t('roll'),
      align: 'end',
      cell: (r) => (r.roll != null ? formatIdentifier(r.roll) : '—'),
    },
    {
      id: 'guardian',
      header: t('guardian'),
      cell: (r) =>
        r.guardian ? (
          <span className="flex flex-col">
            <span>{pick(locale, r.guardian) || '—'}</span>
            {isDialable(r.guardian.phone) ? (
              <a
                href={`tel:${r.guardian.phone}`}
                className="text-link text-xs underline-offset-2 hover:underline"
              >
                <PhoneText phone={r.guardian.phone} />
              </a>
            ) : (
              <PhoneText phone={r.guardian.phone} className="text-muted-foreground text-xs" />
            )}
          </span>
        ) : (
          '—'
        ),
    },
    {
      id: 'openDues',
      header: t('openDues'),
      align: 'end',
      cell: (r) => f(r.openDues),
    },
    {
      id: 'principal',
      header: t('principal'),
      align: 'end',
      cell: (r) => taka(r.principalPaisa),
      foot: taka(totals.principal),
    },
    {
      id: 'fine',
      header: t('fine'),
      align: 'end',
      sortKey: 'fine',
      cell: (r) => (r.finePaisa > 0 ? taka(r.finePaisa) : '—'),
      foot: totals.fine > 0 ? taka(totals.fine) : '—',
    },
    {
      id: 'total',
      header: t('total'),
      align: 'end',
      sortKey: 'total',
      className: 'font-semibold',
      cell: (r) => taka(r.totalPaisa),
      foot: taka(totals.total),
    },
    {
      id: 'overdue',
      header: t('overdue'),
      align: 'end',
      sortKey: 'overdue',
      cell: (r) =>
        r.overduePaisa > 0 ? <span className="text-destructive">{taka(r.overduePaisa)}</span> : '—',
      foot: totals.overdue > 0 ? taka(totals.overdue) : '—',
    },
    ...(defaulters
      ? ([
          {
            id: 'days',
            header: t('days'),
            align: 'end',
            sortKey: 'days',
            cell: (r) =>
              r.oldestOverdue ? (
                <span className="flex flex-col items-end">
                  <span>
                    {t('daysValue', { count: f(overdueDays(r, today)), n: overdueDays(r, today) })}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {formatDate(r.oldestOverdue, locale)}
                  </span>
                </span>
              ) : (
                '—'
              ),
          },
        ] satisfies Column[])
      : []),
  ];

  const onSort = (next: SortState) => {
    const key = next.key as SortKey;
    // Money and days read best largest first: a new column starts descending.
    const nextDir = key !== sortKey && key !== 'class' ? 'desc' : next.dir;
    const isDefault = key === 'class' && nextDir === 'asc';
    set({ sort: isDefault ? null : key, dir: isDefault || nextDir === 'asc' ? null : nextDir });
  };

  const clearFilters = () => set({ class: null, section: null });
  // The same students on the reminders page (it reads the same URL keys).
  const remindQuery = new URLSearchParams();
  if (chosenClass) remindQuery.set('class', chosenClass.id);
  if (chosenSection) remindQuery.set('section', chosenSection.id);
  if (minDays > 1) remindQuery.set('days', String(minDays));
  const remindHref = `/fees/reminders${remindQuery.toString() ? `?${remindQuery}` : ''}`;
  const title = defaulters ? t('printDefaulters') : t('printDues');
  const filterWords = [
    chosenClass?.name,
    chosenSection && `${sectionLabel} ${chosenSection.name}`,
    defaulters && daysOptions.find((o) => o.value === String(minDays))?.label,
    defaulters && minAmountPaisa > 0 && `${t('overdue')} ≥ ${taka(minAmountPaisa)}`,
  ].filter(Boolean);

  return (
    <div className="print-area flex flex-col gap-(--section-gap)" data-testid={`report-${mode}`}>
      <div className="flex flex-col gap-3 print:hidden">
        <p className="text-muted-foreground max-w-prose text-sm">
          {defaulters ? t('defaultersIntro') : t('duesIntro')}
        </p>
        <div
          className="grid gap-3 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-end"
          role="search"
          aria-label={tc('filters')}
        >
          <SelectField
            id={`${id}-class`}
            label={classLabel}
            className="lg:w-52"
            value={chosenClass?.id ?? ''}
            onChange={(v) => set({ class: v || null, section: null })}
            options={[
              {
                value: '',
                label: tc('allClasses', {
                  classLevel: label('class_level', 'Class', { inText: true }),
                }),
              },
              ...classes.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <SelectField
            id={`${id}-section`}
            label={sectionLabel}
            className="lg:w-44"
            value={chosenSection?.id ?? ''}
            disabled={!chosenClass || chosenClass.sections.length === 0}
            onChange={(v) => set({ section: v || null })}
            options={[
              {
                value: '',
                label: tc('allSections', {
                  section: label('section', 'Section', { inText: true }),
                }),
              },
              ...(chosenClass?.sections ?? []).map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
          {defaulters && (
            <>
              <SelectField
                id={`${id}-days`}
                label={tc('minDays')}
                className="lg:w-48"
                value={String(minDays)}
                onChange={(v) => set({ days: v === '1' ? null : v })}
                options={daysOptions}
              />
              <MoneyField
                id={`${id}-min`}
                label={t('minAmount')}
                className="lg:w-48"
                valuePaisa={minDraft}
                onChange={onMinAmount}
              />
            </>
          )}
          <div className="flex flex-wrap gap-2 sm:col-span-2 lg:ms-auto">
            {defaulters && manages && (
              <ButtonLink variant="outline" href={remindHref}>
                <BellRingIcon aria-hidden />
                {t('remind')}
              </ButtonLink>
            )}
            <Button
              variant="outline"
              onClick={() => void downloadCsv()}
              disabled={!report.data || downloading}
              data-testid="report-csv"
            >
              <DownloadIcon aria-hidden />
              {tc('csv')}
            </Button>
            <Button
              variant="outline"
              onClick={() => window.print()}
              disabled={!report.data}
              data-testid="report-print"
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
      </div>

      {/* The paper's title block. */}
      <div className="hidden print:block">
        <p className="text-lg font-semibold">{context?.tenant.name}</p>
        <p>
          {title}
          {filterWords.length > 0 && `: ${filterWords.join(', ')}`}
        </p>
        {today && (
          <p className="text-sm">{tc('generated', { date: formatDate(today, locale, 'long') })}</p>
        )}
      </div>

      {report.isPending ? (
        <div className="flex flex-col gap-1.5" aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-(--row-h) w-full rounded-md" />
          ))}
        </div>
      ) : report.isError && !report.data ? (
        <LoadError error={report.error} onRetry={() => void report.refetch()} />
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyState
            icon={SearchXIcon}
            title={t('emptyFiltered')}
            hint={t('emptyFilteredHint', {
              classLevel: label('class_level', 'Class', { inText: true }),
              section: label('section', 'Section', { inText: true }),
            })}
            action={
              <Button variant="outline" onClick={clearFilters}>
                <XIcon aria-hidden />
                {tc('clearFilters')}
              </Button>
            }
            testId="report-empty"
          />
        ) : (
          <EmptyState
            icon={CircleCheckIcon}
            title={defaulters ? t('emptyDefaulters') : t('emptyDues')}
            hint={defaulters ? t('emptyDefaultersHint') : t('emptyDuesHint')}
            testId="report-empty"
          />
        )
      ) : (
        <div className={cn('flex flex-col gap-2', report.isPlaceholderData && 'opacity-70')}>
          <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
            <p
              className="text-muted-foreground text-sm"
              aria-live="polite"
              data-testid="result-count"
            >
              {t('count', { count: f(rows.length), n: rows.length })}
            </p>
            {filtered && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <XIcon aria-hidden />
                {tc('clearFilters')}
              </Button>
            )}
          </div>
          {wide ? (
            <DataTable
              className="print-unbound print:rounded-none print:border-0 print:shadow-none"
              testId="report-table"
              caption={title}
              columns={columns}
              rows={sorted}
              rowKey={(r) => r.student.id}
              rowLabel={(r) => `${name(r)}, ${place(r)}`}
              sort={{ key: sortKey, dir }}
              onSortChange={onSort}
              footer={
                <tr>
                  {columns.map((c) => (
                    <td
                      key={c.id}
                      className={cn(
                        'h-(--row-h) px-(--cell-px) py-(--cell-py) align-middle first:ps-4',
                        c.align === 'end' && 'num',
                        c.className,
                      )}
                    >
                      {c.foot}
                    </td>
                  ))}
                </tr>
              }
            />
          ) : (
            <>
              <ul
                className="bg-card rounded-card shadow-card flex flex-col divide-y overflow-hidden border"
                data-testid="report-cards"
              >
                {sorted.slice(0, shown).map((r) => (
                  <DueCard
                    key={r.student.id}
                    row={r}
                    name={name(r)}
                    place={place(r)}
                    days={defaulters ? overdueDays(r, today) : 0}
                  />
                ))}
              </ul>
              {sorted.length > shown && (
                <Button
                  variant="outline"
                  className="self-center print:hidden"
                  onClick={() => setShown((n) => n + CARD_PAGE)}
                >
                  {tc('showMore', { count: f(Math.min(CARD_PAGE, sorted.length - shown)) })}
                </Button>
              )}
              <dl
                className="bg-muted rounded-card grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border px-4 py-3 text-sm"
                data-testid="report-totals"
              >
                <dt className="font-medium">
                  {t('totalRow', { count: f(rows.length), n: rows.length })}
                </dt>
                <dd className="font-numeric text-end text-base font-semibold">
                  {taka(totals.total)}
                </dd>
                {totals.fine > 0 && (
                  <>
                    <dt className="text-muted-foreground">{t('fine')}</dt>
                    <dd className="font-numeric text-end">{taka(totals.fine)}</dd>
                  </>
                )}
                {totals.overdue > 0 && (
                  <>
                    <dt className="text-muted-foreground">{t('overdue')}</dt>
                    <dd className="font-numeric text-destructive text-end">
                      {taka(totals.overdue)}
                    </dd>
                  </>
                )}
              </dl>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** One student on a phone: what they owe, how late, and their guardian a tap away. */
function DueCard({
  row: r,
  name,
  place,
  days,
}: {
  row: FeeDueListRow;
  name: string;
  place: string;
  days: number;
}) {
  const t = useTranslations('fees.reports.dues');
  const tc = useTranslations('fees.reports.common');
  const locale = useLocale() as Locale;
  const f = (n: number) => formatCount(n, locale);
  const taka = (p: number) => formatTaka(p, locale);
  const guardianName = r.guardian ? pick(locale, r.guardian) : '';
  const meta = [
    t('cardOpenDues', { count: f(r.openDues), n: r.openDues }),
    r.finePaisa > 0 && t('cardFine', { amount: taka(r.finePaisa) }),
    days > 0 && t('cardDays', { count: f(days), n: days }),
  ].filter(Boolean);
  return (
    <li className="flex flex-col gap-1.5 px-3 py-3" data-testid="report-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="min-w-0 truncate py-0.5 leading-normal font-semibold">{name}</span>
          <span className="text-muted-foreground text-sm leading-normal">
            {place && <>{place} · </>}
            {r.roll != null && (
              <>
                {t('roll')} <span className="tabular-nums">{formatIdentifier(r.roll)}</span> ·{' '}
              </>
            )}
            <span className="whitespace-nowrap tabular-nums" dir="ltr">
              {formatIdentifier(r.student.studentCode)}
            </span>
          </span>
        </div>
        <div className="flex shrink-0 flex-col items-end">
          <span className="font-numeric text-lg leading-normal font-semibold">
            {taka(r.totalPaisa)}
          </span>
          {r.overduePaisa > 0 && (
            <span className="text-destructive text-sm leading-normal">
              {t('cardOverdue', { amount: taka(r.overduePaisa) })}
            </span>
          )}
        </div>
      </div>
      <p className="text-muted-foreground text-sm">{meta.join(' · ')}</p>
      {r.guardian && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground flex min-w-0 flex-1 gap-1.5 text-sm">
            <span className="min-w-0 truncate py-0.5">{guardianName}</span>
            <PhoneText phone={r.guardian.phone} className="shrink-0 py-0.5" />
          </span>
          {isDialable(r.guardian.phone) && (
            <a
              href={`tel:${r.guardian.phone}`}
              className={buttonVariants({
                variant: 'outline',
                size: 'icon-lg',
                className: 'shrink-0 rounded-full print:hidden',
              })}
              aria-label={tc('call', { name: guardianName || formatIdentifier(r.guardian.phone) })}
            >
              <PhoneIcon aria-hidden className="size-5" />
            </a>
          )}
        </div>
      )}
    </li>
  );
}

'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  formatCount,
  parseTaka,
  type FeeAmountsMatrix,
  type SetFeeAmountsInput,
  type SetupAcademicYear,
} from '@jantrik/shared';
import {
  ChevronDownIcon,
  CopyIcon,
  CornerDownRightIcon,
  GraduationCapIcon,
  TableIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Fragment, useState } from 'react';
import { SectionCard, SelectField } from '@/components/form-kit';
import { ActionBar } from '@/components/form-layout';
import { Button, ButtonLink } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick } from '@/lib/fees';
import { useLabel } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { RecalculateNotice } from './dues-actions';
import {
  EmptyState,
  FeeDialog,
  LoadError,
  localDigits,
  useAcademicYears,
  useFeeMutation,
  useFeeQuery,
  YearSelect,
} from './kit';

const cellKey = (headId: string, classId: string, groupId: string | null) =>
  `${headId}|${classId}|${groupId ?? ''}`;

/** Paisa → the text a cell shows (no grouping: easy to correct), in the UI's digits. */
const toText = (paisa: number | null, locale: string) =>
  paisa === null
    ? ''
    : localDigits(paisa % 100 === 0 ? String(paisa / 100) : (paisa / 100).toFixed(2), locale);

/** A cell's text → paisa (null = empty, i.e. not charged / same as the class), or 'invalid'. */
const parseCell = (text: string): number | null | 'invalid' =>
  text.trim() === '' ? null : (parseTaka(text) ?? 'invalid');

/** How much each class pays per head in a year: one grid, saved together. */
export function AmountsSection() {
  const t = useTranslations('fees.setup.amounts');
  const label = useLabel();
  const years = useAcademicYears();
  const [chosen, setChosen] = useState<string | null>(null);
  const yearId = chosen ?? years.data?.find((y) => y.isCurrent)?.id ?? years.data?.[0]?.id ?? null;
  const matrix = useFeeQuery<FeeAmountsMatrix>(
    yearId ? `/fees/amounts?academicYearId=${yearId}` : null,
  );
  const year = years.data?.find((y) => y.id === yearId) ?? null;

  return (
    <>
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <p className="text-muted-foreground max-w-prose text-sm">
          {t('intro', { classLevel: label('class_level', 'Class', { inText: true }) })}
        </p>
      </header>
      {years.isPending ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : years.isError ? (
        <LoadError error={years.error} onRetry={() => void years.refetch()} />
      ) : !yearId || !year ? (
        <EmptyState
          icon={GraduationCapIcon}
          title={t('noYearTitle')}
          text={t('noYearText')}
          action={<ButtonLink href="/setup">{t('goToYears')}</ButtonLink>}
        />
      ) : matrix.isPending ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : matrix.isError ? (
        <LoadError error={matrix.error} onRetry={() => void matrix.refetch()} />
      ) : (
        <AmountsGrid
          key={yearId}
          matrix={matrix.data}
          year={year}
          years={years.data}
          onYear={setChosen}
        />
      )}
    </>
  );
}

function AmountsGrid({
  matrix,
  year,
  years,
  onYear,
}: {
  matrix: FeeAmountsMatrix;
  year: SetupAcademicYear;
  years: SetupAcademicYear[];
  onYear: (id: string) => void;
}) {
  const t = useTranslations('fees.setup.amounts');
  const tKit = useTranslations('fees.setup.kit');
  const tCommon = useTranslations('fees.common');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Record<string, string>>({});
  // Classes whose study-group rows are open: those with group amounts, to begin with.
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(matrix.amounts.filter((a) => a.studyGroupId !== null).map((a) => a.classLevelId)),
  );
  const [copying, setCopying] = useState(false);
  const [saved, setSaved] = useState(false);
  const [tried, setTried] = useState(false);

  const heads = matrix.heads.filter((h) => h.isActive);
  const classes = [...matrix.classLevels].sort((a, b) => a.sortOrder - b.sortOrder);
  const groups = [...matrix.studyGroups].sort((a, b) => a.sortOrder - b.sortOrder);
  const original = new Map(
    matrix.amounts.map((a) => [
      cellKey(a.feeHeadId, a.classLevelId, a.studyGroupId),
      a.amountPaisa,
    ]),
  );
  const text = (k: string) => edits[k] ?? toText(original.get(k) ?? null, locale);

  // What changed, and what cannot be saved.
  const changes: SetFeeAmountsInput['amounts'] = [];
  let invalid = 0;
  for (const [k, value] of Object.entries(edits)) {
    const parsed = parseCell(value);
    if (parsed === 'invalid') {
      invalid++;
      continue;
    }
    if (parsed === (original.get(k) ?? null)) continue;
    const [feeHeadId, classLevelId, groupId] = k.split('|') as [string, string, string];
    changes.push({ feeHeadId, classLevelId, studyGroupId: groupId || null, amountPaisa: parsed });
  }
  const dirty = changes.length > 0 || invalid > 0;

  const save = useFeeMutation(
    (body: SetFeeAmountsInput) =>
      client.api<FeeAmountsMatrix>('/fees/amounts', { method: 'PUT', json: body }),
    {
      success: t('saved'),
      onSuccess: (next) => {
        queryClient.setQueryData(
          ['fees-setup', session?.tenant?.id, `/fees/amounts?academicYearId=${year.id}`],
          next,
        );
        setEdits({});
        setTried(false);
        if (year.isCurrent) setSaved(true);
      },
    },
  );

  const cell = (headId: string, classId: string, groupId: string | null, name: string) => {
    const k = cellKey(headId, classId, groupId);
    const value = text(k);
    const bad = parseCell(value) === 'invalid';
    const changed = k in edits && !bad && parseCell(value) !== (original.get(k) ?? null);
    const inherited = groupId ? text(cellKey(headId, classId, null)) : '';
    return (
      <td key={headId} className="px-1.5 py-1.5">
        <Input
          value={value}
          onChange={(e) => setEdits((x) => ({ ...x, [k]: e.target.value }))}
          inputMode="decimal"
          autoComplete="off"
          aria-label={name}
          aria-invalid={bad && (tried || value.length > 0) ? true : undefined}
          placeholder={groupId ? inherited || '—' : '—'}
          className={cn(
            'w-24 text-end tabular-nums',
            changed && 'border-primary-ink bg-primary-soft',
          )}
          data-testid="fee-amount-cell"
          data-cell={k}
        />
      </td>
    );
  };

  if (heads.length === 0 || classes.length === 0) {
    return (
      <SectionCard id="fees-amounts" title={t('gridTitle', { year: year.name })}>
        <YearSelect
          id="fees-amounts-year"
          years={years}
          value={year.id}
          onChange={onYear}
          className="sm:max-w-xs"
        />
        {heads.length === 0 ? (
          <EmptyState
            icon={TableIcon}
            title={t('noHeadsTitle')}
            text={t('noHeadsText')}
            action={<ButtonLink href="/fees/setup/heads">{t('goToHeads')}</ButtonLink>}
          />
        ) : (
          <EmptyState
            icon={GraduationCapIcon}
            title={t('noClassesTitle', {
              classLevel: label('class_level', 'Class', { inText: true }),
            })}
            text={t('noClassesText', {
              classLevel: label('class_level', 'Class', { inText: true }),
            })}
            action={<ButtonLink href="/setup/classes">{t('goToClasses')}</ButtonLink>}
          />
        )}
      </SectionCard>
    );
  }

  return (
    <>
      <form
        className="flex flex-col gap-(--section-gap)"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (invalid > 0 || changes.length === 0) return;
          save.mutate({ academicYearId: year.id, amounts: changes });
        }}
        noValidate
      >
        <SectionCard
          id="fees-amounts"
          title={t('gridTitle', { year: year.name })}
          hint={t('gridHint')}
          actions={
            years.length > 1 ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setCopying(true)}
                disabled={dirty}
                title={dirty ? t('copySaveFirst') : undefined}
                data-testid="fee-amounts-copy"
              >
                <CopyIcon aria-hidden />
                {t('copy')}
              </Button>
            ) : undefined
          }
        >
          <div className="flex flex-wrap items-end gap-3">
            <YearSelect
              id="fees-amounts-year"
              years={years}
              value={year.id}
              onChange={onYear}
              disabled={dirty}
              hint={dirty ? t('yearSaveFirst') : undefined}
              className="w-full sm:w-64"
            />
            <p className="text-muted-foreground pb-2 text-sm">{t('unit')}</p>
          </div>
          {saved && <RecalculateNotice text={t('savedNotice')} onDismiss={() => setSaved(false)} />}
          {/* The grid scrolls inside its own box on a phone; the class column stays put. */}
          <div className="-mx-(--panel-p) overflow-x-auto border-y" data-testid="fee-amounts-grid">
            <table className="w-max min-w-full border-collapse text-sm">
              <thead>
                <tr className="border-b">
                  <th
                    scope="col"
                    className="bg-card sticky start-0 z-10 min-w-36 px-(--panel-p) py-2 text-start font-medium"
                  >
                    {label('class_level', 'Class')}
                  </th>
                  {heads.map((h) => (
                    <th
                      key={h.id}
                      scope="col"
                      className="max-w-40 min-w-27 px-1.5 py-2 text-end align-bottom"
                    >
                      <span className="block font-medium wrap-break-word">{pick(locale, h)}</span>
                      <span className="text-muted-foreground block text-xs font-normal">
                        {tCommon(`frequency.${h.frequency}`)}
                      </span>
                    </th>
                  ))}
                  <th aria-hidden className="w-(--panel-p)" />
                </tr>
              </thead>
              <tbody>
                {classes.map((c) => {
                  const className = pick(locale, c);
                  const showGroups = groups.length > 0 && open.has(c.id);
                  return (
                    <Fragment key={c.id}>
                      <tr className="border-t first:border-t-0" data-testid="fee-amount-row">
                        <th
                          scope="row"
                          className="bg-card sticky start-0 z-10 px-(--panel-p) py-1.5 text-start font-medium"
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="wrap-break-word">{className}</span>
                            {groups.length > 0 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-expanded={showGroups}
                                aria-label={t('groupsToggle', {
                                  group: label('study_group', 'Group', { inText: true }),
                                  classLevel: className,
                                })}
                                onClick={() =>
                                  setOpen((s) => {
                                    const next = new Set(s);
                                    if (next.has(c.id)) next.delete(c.id);
                                    else next.add(c.id);
                                    return next;
                                  })
                                }
                                className="text-muted-foreground"
                              >
                                {label('study_group', 'Group')}
                                <ChevronDownIcon
                                  aria-hidden
                                  className={cn('transition-transform', showGroups && 'rotate-180')}
                                />
                              </Button>
                            )}
                          </span>
                        </th>
                        {heads.map((h) =>
                          cell(h.id, c.id, null, `${className}: ${pick(locale, h)}`),
                        )}
                        <td aria-hidden />
                      </tr>
                      {showGroups &&
                        groups.map((g) => {
                          const groupName = pick(locale, g);
                          return (
                            <tr key={`${c.id}|${g.id}`} className="bg-muted/50">
                              <th
                                scope="row"
                                className="bg-muted sticky start-0 z-10 py-1.5 ps-[calc(var(--panel-p)+0.5rem)] pe-(--panel-p) text-start font-normal"
                              >
                                <span className="flex items-center gap-1.5">
                                  <CornerDownRightIcon
                                    aria-hidden
                                    className="text-muted-foreground size-4 shrink-0"
                                  />
                                  <span className="wrap-break-word">{groupName}</span>
                                </span>
                              </th>
                              {heads.map((h) =>
                                cell(
                                  h.id,
                                  c.id,
                                  g.id,
                                  `${className}, ${groupName}: ${pick(locale, h)}`,
                                ),
                              )}
                              <td aria-hidden />
                            </tr>
                          );
                        })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {groups.length > 0 && (
            <p className="text-muted-foreground text-sm">
              {t('groupsHint', { group: label('study_group', 'Group', { inText: true }) })}
            </p>
          )}
        </SectionCard>

        <ActionBar
          note={
            invalid > 0
              ? t('invalidCells', { count: invalid, n: formatCount(invalid, locale) })
              : changes.length > 0
                ? t('changedCells', {
                    count: changes.length,
                    n: formatCount(changes.length, locale),
                  })
                : undefined
          }
          className="sm:mx-0 sm:rounded-xl sm:border"
        >
          <Button
            type="button"
            variant="outline"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setEdits({});
              setTried(false);
            }}
          >
            {tKit('cancel')}
          </Button>
          <Button
            type="submit"
            disabled={changes.length === 0 || invalid > 0 || save.isPending}
            data-testid="fee-amounts-save"
          >
            {tKit('save')}
          </Button>
        </ActionBar>
      </form>
      {copying && (
        <CopyDialog
          to={year}
          years={years.filter((y) => y.id !== year.id)}
          onClose={() => setCopying(false)}
        />
      )}
    </>
  );
}

/** Fill this year's empty cells from another year (cells already set are kept). */
function CopyDialog({
  to,
  years,
  onClose,
}: {
  to: SetupAcademicYear;
  years: SetupAcademicYear[];
  onClose: () => void;
}) {
  const t = useTranslations('fees.setup.amounts');
  const tKit = useTranslations('fees.setup.kit');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const [from, setFrom] = useState(years[0]?.id ?? '');
  const copy = useFeeMutation(
    () =>
      client.api<{ copied: number }>('/fees/amounts/copy', {
        method: 'POST',
        json: { fromAcademicYearId: from, toAcademicYearId: to.id },
      }),
    {
      success: (out) =>
        out.copied > 0
          ? t('copied', { count: out.copied, n: formatCount(out.copied, locale) })
          : t('copiedNone'),
      onSuccess: onClose,
    },
  );
  return (
    <FeeDialog
      onClose={onClose}
      title={t('copyTitle', { year: to.name })}
      description={t('copyHint')}
      submitLabel={t('copySubmit')}
      pending={copy.isPending}
      onSubmit={() => from && copy.mutate(undefined)}
      testId="fee-amounts-copy-dialog"
      submitTestId="fee-amounts-copy-submit"
    >
      <SelectField
        id="fees-copy-from"
        label={t('copyFrom')}
        value={from}
        onChange={setFrom}
        options={years.map((y) => ({
          value: y.id,
          label: y.isCurrent ? tKit('currentYear', { name: y.name }) : y.name,
        }))}
      />
    </FeeDialog>
  );
}

'use client';

import {
  formatDate,
  type FeeHeadView,
  type FeeTermView,
  type SetupAcademicYear,
} from '@jantrik/shared';
import {
  CalendarRangeIcon,
  EllipsisVerticalIcon,
  GraduationCapIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { SectionCard, TextField } from '@/components/form-kit';
import { Button, ButtonLink } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick } from '@/lib/fees';
import {
  EmptyState,
  FeeConfirmDialog,
  FeeDialog,
  fieldsFromError,
  LoadError,
  localDigits,
  parseWhole,
  useAcademicYears,
  useFeeMutation,
  useFeeQuery,
  YearSelect,
} from './kit';

type Dialog =
  { kind: 'edit'; term: FeeTermView | null } | { kind: 'delete'; term: FeeTermView } | null;

/** Terms of a year: each "per term" head falls due on every term's due date. */
export function TermsSection() {
  const t = useTranslations('fees.setup.terms');
  const locale = useLocale() as Locale;
  const years = useAcademicYears();
  const heads = useFeeQuery<FeeHeadView[]>('/fees/heads');
  const [chosen, setChosen] = useState<string | null>(null);
  const yearId = chosen ?? years.data?.find((y) => y.isCurrent)?.id ?? years.data?.[0]?.id ?? null;
  const year = years.data?.find((y) => y.id === yearId) ?? null;
  const terms = useFeeQuery<FeeTermView[]>(yearId ? `/fees/terms?academicYearId=${yearId}` : null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const perTerm = (heads.data ?? []).filter((h) => h.isActive && h.frequency === 'PER_TERM');
  const list = [...(terms.data ?? [])].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.dueDate.localeCompare(b.dueDate),
  );

  if (years.isPending) return <Skeleton className="h-80 rounded-xl" />;
  if (years.isError) return <LoadError error={years.error} onRetry={() => void years.refetch()} />;
  if (!year)
    return (
      <EmptyState
        icon={GraduationCapIcon}
        title={t('noYearTitle')}
        text={t('noYearText')}
        action={<ButtonLink href="/setup">{t('goToYears')}</ButtonLink>}
      />
    );

  return (
    <>
      <SectionCard
        id="fees-terms"
        title={t('title')}
        hint={t('hint')}
        actions={
          <Button
            onClick={() => setDialog({ kind: 'edit', term: null })}
            data-testid="fee-term-add"
          >
            <PlusIcon aria-hidden />
            {t('add')}
          </Button>
        }
      >
        <YearSelect
          id="fees-terms-year"
          years={years.data}
          value={year.id}
          onChange={setChosen}
          className="sm:max-w-xs"
        />
        {heads.isSuccess && (
          <p className="bg-muted flex gap-2 rounded-xl p-3 text-sm">
            <InfoIcon aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            <span>
              {perTerm.length > 0
                ? t('perTermHeads', { names: perTerm.map((h) => pick(locale, h)).join(', ') })
                : t('noPerTermHeads')}
            </span>
          </p>
        )}
        {terms.isPending ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : terms.isError ? (
          <LoadError error={terms.error} onRetry={() => void terms.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={CalendarRangeIcon}
            title={t('emptyTitle', { year: year.name })}
            text={t('emptyText')}
            action={
              <Button onClick={() => setDialog({ kind: 'edit', term: null })}>
                <PlusIcon aria-hidden />
                {t('add')}
              </Button>
            }
          />
        ) : (
          <ol className="flex flex-col gap-2" data-testid="fee-terms">
            {list.map((term) => {
              const name = pick(locale, term);
              return (
                <li
                  key={term.id}
                  className="flex min-w-0 items-start gap-3 rounded-xl border p-3"
                  data-testid="fee-term-row"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
                    <span className="font-semibold wrap-break-word sm:w-48 sm:shrink-0">
                      {name}
                    </span>
                    <span className="text-muted-foreground text-sm">
                      {t('opens', { date: formatDate(term.opensOn, locale) })}
                    </span>
                    <span className="text-sm">
                      {t('due', { date: formatDate(term.dueDate, locale) })}
                    </span>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button variant="ghost" size="icon" aria-label={t('actions', { name })}>
                          <EllipsisVerticalIcon aria-hidden />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem onClick={() => setDialog({ kind: 'edit', term })}>
                        <PencilIcon aria-hidden />
                        {t('edit')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setDialog({ kind: 'delete', term })}
                      >
                        <Trash2Icon aria-hidden />
                        {t('delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ol>
        )}
      </SectionCard>
      {dialog?.kind === 'edit' && (
        <TermDialog
          term={dialog.term}
          year={year}
          nextSort={Math.min(9999, Math.max(0, ...list.map((x) => x.sortOrder)) + 10)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteTermDialog term={dialog.term} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function TermDialog({
  term,
  year,
  nextSort,
  onClose,
}: {
  term: FeeTermView | null;
  year: SetupAcademicYear;
  nextSort: number;
  onClose: () => void;
}) {
  const t = useTranslations('fees.setup.terms');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const [nameBn, setNameBn] = useState(term?.nameBn ?? '');
  const [nameEn, setNameEn] = useState(term?.nameEn ?? '');
  const [opensOn, setOpensOn] = useState<string>(term?.opensOn ?? '');
  const [dueDate, setDueDate] = useState<string>(term?.dueDate ?? '');
  const [sortText, setSortText] = useState(
    localDigits(String(term?.sortOrder ?? nextSort), locale),
  );
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<Set<string>>(new Set());
  const sort = parseWhole(sortText);
  const errors: Partial<Record<string, string>> = {};
  if (!nameBn.trim()) errors.nameBn = t('errorRequired');
  if (!nameEn.trim()) errors.nameEn = t('errorRequired');
  if (!opensOn) errors.opensOn = t('errorDate');
  if (!dueDate) errors.dueDate = t('errorDate');
  else if (opensOn && dueDate < opensOn) errors.dueDate = t('errorDueBeforeOpen');
  if (sort === null || sort > 9999) errors.sortOrder = t('errorSort');
  if (server.has('nameBn')) errors.nameBn ??= t('errorDuplicate');
  const shown = (k: string) => (tried ? (errors[k] ?? null) : null);

  const save = useFeeMutation(
    () => {
      const body = {
        nameBn: nameBn.trim(),
        nameEn: nameEn.trim(),
        opensOn,
        dueDate,
        sortOrder: sort!,
      };
      return term
        ? client.api<FeeTermView>(`/fees/terms/${term.id}`, { method: 'PATCH', json: body })
        : client.api<FeeTermView>('/fees/terms', {
            method: 'POST',
            json: { ...body, academicYearId: year.id },
          });
    },
    {
      success: term ? t('saved') : t('created'),
      onSuccess: onClose,
      onError: (e) => setServer(fieldsFromError(e)),
    },
  );
  return (
    <FeeDialog
      onClose={onClose}
      title={
        term ? t('editTitle', { name: pick(locale, term) }) : t('newTitle', { year: year.name })
      }
      description={t('dialogHint')}
      submitLabel={term ? t('save') : t('create')}
      pending={save.isPending}
      onSubmit={() => {
        setTried(true);
        if (Object.keys(errors).length === 0) save.mutate(undefined);
      }}
      testId="fee-term-dialog"
      submitTestId="fee-term-save"
      wide
    >
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <TextField
          id="term-name-bn"
          label={t('nameBn')}
          value={nameBn}
          onChange={(v) => {
            setNameBn(v);
            setServer(new Set());
          }}
          maxLength={100}
          required
          placeholder={t('nameBnPlaceholder')}
          error={shown('nameBn')}
        />
        <TextField
          id="term-name-en"
          label={t('nameEn')}
          value={nameEn}
          onChange={setNameEn}
          maxLength={100}
          required
          lang="en"
          placeholder={t('nameEnPlaceholder')}
          error={shown('nameEn')}
        />
        <TextField
          id="term-opens"
          type="date"
          label={t('opensOn')}
          hint={t('opensOnHint')}
          value={opensOn}
          onChange={setOpensOn}
          min={year.startDate}
          max={year.endDate}
          required
          error={shown('opensOn')}
        />
        <TextField
          id="term-due"
          type="date"
          label={t('dueDate')}
          hint={t('dueDateHint')}
          value={dueDate}
          onChange={setDueDate}
          min={opensOn || year.startDate}
          max={year.endDate}
          required
          error={shown('dueDate')}
        />
        <TextField
          id="term-sort"
          label={t('sortOrder')}
          hint={t('sortOrderHint')}
          value={sortText}
          onChange={setSortText}
          inputMode="numeric"
          autoComplete="off"
          className="tabular-nums"
          error={shown('sortOrder')}
        />
      </div>
    </FeeDialog>
  );
}

function DeleteTermDialog({ term, onClose }: { term: FeeTermView; onClose: () => void }) {
  const t = useTranslations('fees.setup.terms');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const remove = useFeeMutation(() => client.api(`/fees/terms/${term.id}`, { method: 'DELETE' }), {
    success: t('deleted'),
    onSuccess: onClose,
  });
  return (
    <FeeConfirmDialog
      title={t('deleteTitle', { name: pick(locale, term) })}
      body={t('deleteBody')}
      confirmLabel={t('delete')}
      destructive
      pending={remove.isPending}
      onConfirm={() => remove.mutate(undefined)}
      onClose={onClose}
      confirmTestId="fee-term-delete-confirm"
    />
  );
}

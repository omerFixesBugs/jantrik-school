'use client';

import {
  dateToDb,
  formatCount,
  formatDate,
  suggestNextYear,
  type SetupAcademicYear,
} from '@jantrik/shared';
import { CalendarPlusIcon, CheckCircle2Icon, PlusIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { SectionCard, TextField, ToggleField, useFieldErrors } from '@/components/form-kit';
import {
  ConfirmDialog,
  FormDialog,
  RowActions,
  SetupPage,
  useEditing,
  useSetupMutation,
  useSetupQuery,
} from '@/components/setup/setup-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel } from '@/lib/hooks';

const PATH = '/setup/academic-years';

/** Academic years: one is current; "next year" copies the sections (no students). */
export default function AcademicYearsPage() {
  const t = useTranslations('setup');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const describe = useErrorMessage();
  const { client } = useAuth();
  const years = useSetupQuery<SetupAcademicYear[]>(PATH);
  const { editing, setEditing, close } = useEditing<SetupAcademicYear>();
  const [nextFrom, setNextFrom] = useState<SetupAcademicYear | null>(null);
  const [deleting, setDeleting] = useState<SetupAcademicYear | null>(null);
  const [makeCurrent, setMakeCurrent] = useState<SetupAcademicYear | null>(null);
  const yearLabel = label('academic_year', 'Academic Year');
  const yearInText = label('academic_year', 'Academic Year', { inText: true });

  const setCurrent = useSetupMutation(
    (y: SetupAcademicYear) => client.api(`${PATH}/${y.id}/current`, { method: 'POST' }),
    { success: t('saved'), onSuccess: () => setMakeCurrent(null) },
  );
  const remove = useSetupMutation(
    (y: SetupAcademicYear) => client.api(`${PATH}/${y.id}`, { method: 'DELETE' }),
    { success: t('deleted'), onSuccess: () => setDeleting(null) },
  );

  const range = (y: SetupAcademicYear) =>
    `${formatDate(dateToDb(y.startDate), locale, 'medium')} – ${formatDate(dateToDb(y.endDate), locale, 'medium')}`;
  const latest = years.data?.[0];

  return (
    <SetupPage tab="years">
      <SectionCard
        id="setup-years"
        title={yearLabel}
        hint={t('yearsHint', { year: yearInText })}
        actions={
          <>
            {latest && (
              <Button variant="outline" onClick={() => setNextFrom(latest)} data-testid="next-year">
                <CalendarPlusIcon aria-hidden />
                {t('nextYear', { year: yearInText })}
              </Button>
            )}
            <Button onClick={() => setEditing('new')} data-testid="add-year">
              <PlusIcon aria-hidden />
              {t('add')}
            </Button>
          </>
        }
      >
        {years.isPending ? (
          <Skeleton className="h-32" />
        ) : years.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{describe(years.error)}</AlertDescription>
          </Alert>
        ) : years.data.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noYears', { year: yearInText })}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border" data-testid="year-list">
            {years.data.map((y) => (
              <li key={y.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold break-words">{y.name}</span>
                    {y.isCurrent && (
                      <Badge variant="success">
                        <CheckCircle2Icon aria-hidden />
                        {t('current')}
                      </Badge>
                    )}
                  </span>
                  <span className="text-muted-foreground text-sm">{range(y)}</span>
                  <span className="text-muted-foreground text-sm">
                    {t('yearUsage', {
                      sections: formatCount(y.sectionCount, locale),
                      students: formatCount(y.enrolmentCount, locale),
                      ns: y.sectionCount,
                      nst: y.enrolmentCount,
                      section: label('section', 'Section', { inText: true }),
                    })}
                  </span>
                </span>
                {!y.isCurrent && (
                  <Button size="sm" variant="outline" onClick={() => setMakeCurrent(y)}>
                    {t('makeCurrent')}
                  </Button>
                )}
                <RowActions
                  name={y.name}
                  active
                  inUse={y.isCurrent || y.sectionCount > 0 || y.enrolmentCount > 0}
                  onEdit={() => setEditing(y)}
                  onDelete={() => setDeleting(y)}
                />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {editing !== null && (
        <YearDialog
          key={editing === 'new' ? 'new' : editing.id}
          year={editing === 'new' ? null : editing}
          onClose={close}
        />
      )}
      {nextFrom && (
        <YearDialog
          key={`next-${nextFrom.id}`}
          year={null}
          from={nextFrom}
          onClose={() => setNextFrom(null)}
        />
      )}
      <ConfirmDialog
        open={makeCurrent !== null}
        onOpenChange={(o) => !o && setMakeCurrent(null)}
        title={t('makeCurrentTitle', { name: makeCurrent?.name ?? '' })}
        body={t('makeCurrentBody', { year: yearInText })}
        confirmLabel={t('makeCurrent')}
        destructive={false}
        pending={setCurrent.isPending}
        onConfirm={() => makeCurrent && setCurrent.mutate(makeCurrent)}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('deleteTitle', { name: deleting?.name ?? '' })}
        confirmLabel={t('delete')}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </SetupPage>
  );
}

function YearDialog({
  year,
  from,
  onClose,
}: {
  year: SetupAcademicYear | null;
  from?: SetupAcademicYear;
  onClose: () => void;
}) {
  const t = useTranslations('setup');
  const label = useLabel();
  const fieldErrors = useFieldErrors();
  const { client } = useAuth();
  const initial = year ?? (from ? suggestNextYear(from) : { name: '', startDate: '', endDate: '' });
  const [name, setName] = useState(initial.name);
  const [startDate, setStart] = useState(initial.startDate);
  const [endDate, setEnd] = useState(initial.endDate);
  const [copy, setCopy] = useState(Boolean(from));
  const yearInText = label('academic_year', 'Academic Year', { inText: true });
  const section = label('section', 'Section', { inText: true });

  const save = useSetupMutation(
    () =>
      year
        ? client.api(`${PATH}/${year.id}`, { method: 'PUT', json: { name, startDate, endDate } })
        : client.api(PATH, {
            method: 'POST',
            json: { name, startDate, endDate, copySectionsFrom: copy && from ? from.id : null },
          }),
    { success: t('saved'), onSuccess: onClose },
  );
  const errors = fieldErrors(save.error);

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        year
          ? t('editTitle', { name: year.name })
          : from
            ? t('nextYear', { year: yearInText })
            : t('addYear', { year: yearInText })
      }
      submitLabel={t('save')}
      pending={save.isPending}
      onSubmit={() => save.mutate(undefined)}
      testId="year-dialog"
    >
      <TextField
        id="year-name"
        label={t('name')}
        value={name}
        onChange={setName}
        required
        maxLength={40}
        error={errors['name']}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id="year-start"
          label={t('start')}
          type="date"
          value={startDate}
          onChange={setStart}
          required
          error={errors['startDate']}
        />
        <TextField
          id="year-end"
          label={t('end')}
          type="date"
          value={endDate}
          min={startDate}
          onChange={setEnd}
          required
          error={errors['endDate']}
        />
      </div>
      {from && (
        <ToggleField
          id="year-copy"
          checked={copy}
          onChange={setCopy}
          label={t('copySections', { section, name: from.name })}
          hint={t('copySectionsHint')}
        />
      )}
    </FormDialog>
  );
}

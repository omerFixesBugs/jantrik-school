'use client';

import { suggestNextYear, type SetupAcademicYear } from '@jantrik/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { TextField, ToggleField, useFieldErrors } from '@/components/form-kit';
import { FormDialog, useSetupMutation } from '@/components/setup/setup-kit';
import { useAuth } from '@/lib/auth/auth-provider';
import { useLabel } from '@/lib/hooks';

const PATH = '/setup/academic-years';

/**
 * Add or edit an academic year; with `from`, the next year after it (its sections can be copied).
 * Used by the setup page and the setup wizard.
 */
export function YearDialog({
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

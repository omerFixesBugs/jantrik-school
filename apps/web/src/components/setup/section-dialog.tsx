'use client';

import {
  toAsciiDigits,
  type SetupClassLevel,
  type SetupSection,
  type SetupShift,
} from '@jantrik/shared';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { SelectField, TextField, useFieldErrors } from '@/components/form-kit';
import { FormDialog, useSetupMutation } from '@/components/setup/setup-kit';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useLabel } from '@/lib/hooks';
import { displayName } from '@/lib/names';

/** Add a section to a class in an academic year, or edit one. Setup page and setup wizard. */
export function SectionDialog({
  yearId,
  classLevel,
  item,
  shifts,
  onClose,
}: {
  yearId: string;
  classLevel: SetupClassLevel;
  item: SetupSection | null;
  shifts: SetupShift[];
  onClose: () => void;
}) {
  const t = useTranslations('setup');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const fieldErrors = useFieldErrors();
  const { client } = useAuth();
  const [name, setName] = useState(item?.name ?? '');
  const [shiftId, setShiftId] = useState(item?.shiftId ?? '');
  const [capacity, setCapacity] = useState(item?.capacity != null ? String(item.capacity) : '');
  const [sortOrder, setSortOrder] = useState(String(item?.sortOrder ?? 0));
  const section = label('section', 'Section');
  const className = displayName(classLevel.nameBn, classLevel.nameEn, locale);

  const save = useSetupMutation(
    () => {
      const cap = capacity.trim() ? Number(toAsciiDigits(capacity)) : null;
      const common = {
        name,
        shiftId: shiftId || null,
        capacity: cap,
        sortOrder: Number(toAsciiDigits(sortOrder)) || 0,
      };
      return item
        ? client.api(`/setup/sections/${item.id}`, { method: 'PATCH', json: common })
        : client.api('/setup/sections', {
            method: 'POST',
            json: { ...common, academicYearId: yearId, classLevelId: classLevel.id },
          });
    },
    { success: t('saved'), onSuccess: onClose },
  );
  const errors = fieldErrors(save.error);
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        item
          ? t('editTitle', { name: `${className}, ${item.name}` })
          : t('addSectionTo', { section, name: className })
      }
      submitLabel={t('save')}
      pending={save.isPending}
      onSubmit={() => save.mutate(undefined)}
      testId="section-dialog"
    >
      <TextField
        id="section-name"
        label={t('name')}
        value={name}
        onChange={setName}
        required
        maxLength={40}
        hint={t('sectionNameHint')}
        error={errors['name']}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          id="section-shift"
          label={label('shift', 'Shift')}
          value={shiftId}
          onChange={setShiftId}
          placeholder={t('none')}
          options={shifts.map((s) => ({
            value: s.id,
            label: displayName(s.nameBn, s.nameEn, locale),
          }))}
        />
        <TextField
          id="section-capacity"
          label={t('capacity')}
          value={capacity}
          onChange={setCapacity}
          inputMode="numeric"
          hint={t('capacityHint')}
          error={errors['capacity']}
        />
      </div>
      <TextField
        id="section-order"
        label={t('sortOrder')}
        value={sortOrder}
        onChange={setSortOrder}
        inputMode="numeric"
        className="sm:max-w-40"
        error={errors['sortOrder']}
      />
    </FormDialog>
  );
}

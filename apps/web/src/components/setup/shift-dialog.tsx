'use client';

import { toAsciiDigits, type SetupShift } from '@jantrik/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { TextField, useFieldErrors } from '@/components/form-kit';
import { FormDialog, useSetupMutation } from '@/components/setup/setup-kit';
import { useAuth } from '@/lib/auth/auth-provider';
import { useLabel } from '@/lib/hooks';

const PATH = '/setup/shifts';

/** Add or edit a shift. Setup page and setup wizard. */
export function ShiftDialog({ item, onClose }: { item: SetupShift | null; onClose: () => void }) {
  const t = useTranslations('setup');
  const label = useLabel();
  const fieldErrors = useFieldErrors();
  const { client } = useAuth();
  const [nameBn, setNameBn] = useState(item?.nameBn ?? '');
  const [nameEn, setNameEn] = useState(item?.nameEn ?? '');
  const [startTime, setStart] = useState(item?.startTime ?? '');
  const [endTime, setEnd] = useState(item?.endTime ?? '');
  const [sortOrder, setSortOrder] = useState(String(item?.sortOrder ?? 0));
  const save = useSetupMutation(
    () => {
      const json = {
        nameBn,
        nameEn,
        startTime,
        endTime,
        sortOrder: Number(toAsciiDigits(sortOrder)) || 0,
      };
      return item
        ? client.api(`${PATH}/${item.id}`, { method: 'PATCH', json })
        : client.api(PATH, { method: 'POST', json });
    },
    { success: t('saved'), onSuccess: onClose },
  );
  const errors = fieldErrors(save.error);
  const shiftLabel = label('shift', 'Shift');
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={item ? t('editTitle', { name: item.nameBn }) : t('addNamed', { name: shiftLabel })}
      submitLabel={t('save')}
      pending={save.isPending}
      onSubmit={() => save.mutate(undefined)}
      testId="shift-dialog"
    >
      <TextField
        id="shift-bn"
        label={t('nameBn')}
        value={nameBn}
        onChange={setNameBn}
        required
        maxLength={80}
        lang="bn"
        error={errors['nameBn']}
      />
      <TextField
        id="shift-en"
        label={t('nameEn')}
        value={nameEn}
        onChange={setNameEn}
        required
        maxLength={80}
        lang="en"
        error={errors['nameEn']}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id="shift-start"
          label={t('startTime')}
          type="time"
          value={startTime}
          onChange={setStart}
          required
          error={errors['startTime']}
        />
        <TextField
          id="shift-end"
          label={t('endTime')}
          type="time"
          value={endTime}
          onChange={setEnd}
          required
          error={errors['endTime']}
        />
      </div>
      <TextField
        id="shift-order"
        label={t('sortOrder')}
        value={sortOrder}
        onChange={setSortOrder}
        inputMode="numeric"
        className="sm:max-w-40"
      />
    </FormDialog>
  );
}

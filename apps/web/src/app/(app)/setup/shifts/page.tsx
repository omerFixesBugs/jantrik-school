'use client';

import { formatCount, formatWallClock, toAsciiDigits, type SetupShift } from '@jantrik/shared';
import { PlusIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { InactiveBadge, SectionCard, TextField, useFieldErrors } from '@/components/form-kit';
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
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel } from '@/lib/hooks';
import { displayName } from '@/lib/names';

const PATH = '/setup/shifts';

export default function ShiftsPage() {
  const t = useTranslations('setup');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const describe = useErrorMessage();
  const { client } = useAuth();
  const clock = (hhmm: string) => formatWallClock(hhmm, locale);
  const shifts = useSetupQuery<SetupShift[]>(PATH);
  const { editing, setEditing, close } = useEditing<SetupShift>();
  const [deleting, setDeleting] = useState<SetupShift | null>(null);
  const shiftLabel = label('shift', 'Shift');

  const toggle = useSetupMutation(
    (s: SetupShift) =>
      client.api(`${PATH}/${s.id}`, { method: 'PATCH', json: { isActive: !s.isActive } }),
    { success: t('saved') },
  );
  const remove = useSetupMutation(
    (s: SetupShift) => client.api(`${PATH}/${s.id}`, { method: 'DELETE' }),
    { success: t('deleted'), onSuccess: () => setDeleting(null) },
  );

  return (
    <SetupPage tab="shifts">
      <SectionCard
        id="setup-shifts"
        title={shiftLabel}
        hint={t('shiftsHint', { section: label('section', 'Section', { inText: true }) })}
        actions={
          <Button onClick={() => setEditing('new')} data-testid="add-shift">
            <PlusIcon aria-hidden />
            {t('addNamed', { name: shiftLabel })}
          </Button>
        }
      >
        {shifts.isPending ? (
          <Skeleton className="h-24" />
        ) : shifts.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{describe(shifts.error)}</AlertDescription>
          </Alert>
        ) : shifts.data.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noShifts')}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border" data-testid="shift-list">
            {shifts.data.map((s) => {
              const name = displayName(s.nameBn, s.nameEn, locale);
              return (
                <li key={s.id} className="flex items-center gap-3 px-3 py-3">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold break-words">{name}</span>
                      <InactiveBadge active={s.isActive} />
                    </span>
                    <span className="text-muted-foreground text-sm">
                      {clock(s.startTime)} – {clock(s.endTime)}
                      {' · '}
                      {t('usedBySections', {
                        count: formatCount(s.usage.sections, locale),
                        n: s.usage.sections,
                        section: label('section', 'Section', { inText: true }),
                      })}
                    </span>
                  </span>
                  <RowActions
                    name={name}
                    active={s.isActive}
                    inUse={s.usage.sections > 0}
                    onEdit={() => setEditing(s)}
                    onToggleActive={() => toggle.mutate(s)}
                    onDelete={() => setDeleting(s)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
      {editing !== null && (
        <ShiftDialog
          key={editing === 'new' ? 'new' : editing.id}
          item={editing === 'new' ? null : editing}
          onClose={close}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('deleteTitle', {
          name: deleting ? displayName(deleting.nameBn, deleting.nameEn, locale) : '',
        })}
        confirmLabel={t('delete')}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </SetupPage>
  );
}

function ShiftDialog({ item, onClose }: { item: SetupShift | null; onClose: () => void }) {
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

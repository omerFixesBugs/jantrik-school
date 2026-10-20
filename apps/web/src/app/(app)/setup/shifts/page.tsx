'use client';

import { formatCount, formatWallClock, type SetupShift } from '@jantrik/shared';
import { PlusIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { InactiveBadge, SectionCard } from '@/components/form-kit';
import {
  ConfirmDialog,
  RowActions,
  SetupPage,
  useEditing,
  useSetupMutation,
  useSetupQuery,
} from '@/components/setup/setup-kit';
import { ShiftDialog } from '@/components/setup/shift-dialog';
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

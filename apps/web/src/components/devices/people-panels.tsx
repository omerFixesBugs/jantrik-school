'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  formatCount,
  formatDate,
  type DeviceIdCollisionView,
  type DevicePersonRef,
  type RemoveFromDevicesResult,
  type StaleDevicePerson,
} from '@jantrik/shared';
import { HourglassIcon, PencilIcon, UserMinusIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { LoadError } from '@/components/fees/reports/kit';
import { SectionCard } from '@/components/form-kit';
import { Pill } from '@/components/kit/pill';
import { ConfirmDialog } from '@/components/setup/setup-kit';
import { Button } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { deviceKeys } from '@/lib/devices/keys';
import { Ascii, refName, useDevicesError } from './kit';
import { useInvalidatePeople } from './people-list';

/** "নাম (S-0123)": a person and, for a student, their code. */
function PersonText({ person }: { person: DevicePersonRef }) {
  const locale = useLocale() as Locale;
  return (
    <span>
      <span className="font-medium">{refName(person, locale)}</span>
      {person.studentCode && (
        <span className="text-muted-foreground">
          {' ('}
          <Ascii value={person.studentCode} className="whitespace-nowrap" />
          {')'}
        </span>
      )}
    </span>
  );
}

/**
 * Numbers someone without an ID wants (their default) while another person holds them, or that
 * two such people want. "Set an ID" opens that person's ID in the list. Nothing when there are none.
 */
export function CollisionsPanel({ onSetId }: { onSetId: (person: DevicePersonRef) => void }) {
  const t = useTranslations('devices.people.collisions');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const collisions = useQuery({
    queryKey: deviceKeys.collisions(session?.tenant?.id),
    queryFn: () => client.api<DeviceIdCollisionView[]>('/attendance/device-people/collisions'),
  });
  if (collisions.isError)
    return <LoadError error={collisions.error} onRetry={() => void collisions.refetch()} />;
  if (!collisions.data || collisions.data.length === 0) return null;
  return (
    <SectionCard
      id="device-collisions"
      title={t('title', { count: formatCount(collisions.data.length, locale) })}
      hint={t('hint')}
    >
      <ul className="flex flex-col divide-y rounded-lg border">
        {collisions.data.map((c) => (
          <li
            key={c.deviceUserId}
            className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-4"
            data-testid="collision"
          >
            <Ascii value={c.deviceUserId} className="w-24 shrink-0 text-lg font-semibold" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
              <p>
                {c.heldBy ? (
                  t.rich('heldBy', { holder: () => <PersonText person={c.heldBy!} /> })
                ) : (
                  <span className="text-muted-foreground">{t('shared')}</span>
                )}
              </p>
              <ul className="flex flex-col gap-1">
                {c.wantedBy.map((p) => (
                  <li
                    key={`${p.kind}:${p.id}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1"
                  >
                    <span className="text-muted-foreground">{t('wants')}</span>
                    <PersonText person={p} />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onSetId(p)}
                      data-testid="collision-set"
                    >
                      <PencilIcon aria-hidden />
                      {t('setId')}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/**
 * People a device still has under an ID they should no longer use there: no longer active here
 * (INACTIVE), or the ID was taken from them (RELEASED: their fingerprints are still on the device,
 * so the ID goes to nobody else yet). "Remove from devices" (one, or all) after a confirm deletes
 * them from the devices; a removal sent and not yet confirmed shows as pending.
 */
export function StalePanel() {
  const t = useTranslations('devices.people.stale');
  const locale = useLocale() as Locale;
  const message = useDevicesError();
  const invalidate = useInvalidatePeople();
  const { client, session } = useAuth();
  const [removing, setRemoving] = useState<StaleDevicePerson[] | null>(null);
  const stale = useQuery({
    queryKey: deviceKeys.stale(session?.tenant?.id),
    queryFn: () => client.api<StaleDevicePerson[]>('/attendance/device-people/stale'),
  });
  const remove = useMutation({
    mutationFn: (people: StaleDevicePerson[]) =>
      client.api<RemoveFromDevicesResult>('/attendance/device-people/remove-from-devices', {
        method: 'POST',
        json: { deviceUserIds: people.map((p) => p.deviceUserId) },
      }),
    onSuccess: (_, people) => {
      setRemoving(null);
      invalidate();
      toast.success(t('done', { count: formatCount(people.length, locale) }));
    },
    onError: (e) => {
      setRemoving(null);
      // PERSON_ACTIVE: someone came back; the list is loaded again.
      invalidate();
      toast.error(message(e));
    },
  });
  if (stale.isError) return <LoadError error={stale.error} onRetry={() => void stale.refetch()} />;
  if (!stale.data || stale.data.length === 0) return null;
  const waiting = stale.data.filter((s) => !s.removing);
  const one = removing?.length === 1 ? removing[0]! : null;
  return (
    <SectionCard
      id="device-stale"
      title={t('title', { count: formatCount(stale.data.length, locale) })}
      hint={t('hint')}
      actions={
        waiting.length > 1 && (
          <Button
            variant="destructive"
            onClick={() => setRemoving(waiting)}
            data-testid="stale-remove-all"
          >
            <UserMinusIcon aria-hidden />
            {t('removeAll')}
          </Button>
        )
      }
    >
      <ul className="flex flex-col divide-y rounded-lg border">
        {stale.data.map((s) => (
          <li
            key={s.deviceUserId}
            className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4"
            data-testid="stale-person"
            data-reason={s.reason}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <PersonText person={s.person} />
              <span className="text-sm">{t(`reason${s.reason}`)}</span>
              <span className="text-muted-foreground text-sm">
                {t.rich('line', {
                  id: s.deviceUserId,
                  v: () => <Ascii value={s.deviceUserId} />,
                  devices: s.devices.map((d) => d.name).join(', '),
                  date: formatDate(s.lastSyncAt, locale),
                })}
              </span>
            </div>
            {s.removing ? (
              <Pill tone="info" className="self-start sm:self-center">
                <HourglassIcon aria-hidden className="size-3.5" />
                {t('pending')}
              </Pill>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="self-start sm:self-center"
                onClick={() => setRemoving([s])}
                data-testid="stale-remove"
              >
                <UserMinusIcon aria-hidden />
                {t('remove')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={
          one
            ? t('confirmOne', { name: refName(one.person, locale), id: one.deviceUserId })
            : t('confirmMany', { count: formatCount(removing?.length ?? 0, locale) })
        }
        body={t('confirmBody')}
        confirmLabel={t('remove')}
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </SectionCard>
  );
}

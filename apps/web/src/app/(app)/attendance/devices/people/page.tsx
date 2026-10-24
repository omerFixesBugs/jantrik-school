'use client';

import { useQuery } from '@tanstack/react-query';
import {
  toAsciiDigits,
  type DeviceList,
  type DevicePeopleList,
  type DevicePersonRef,
} from '@jantrik/shared';
import { ArrowLeftIcon, InfoIcon, LockIcon } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useState } from 'react';
import { AttendanceTabs, isAdminRole } from '@/components/attendance/attendance-tabs';
import { Ascii } from '@/components/devices/kit';
import { CollisionsPanel, StalePanel } from '@/components/devices/people-panels';
import { PeopleList } from '@/components/devices/people-list';
import { CsvMenu, DefaultIdsButton, SendToDevicesButton } from '@/components/devices/people-tools';
import { LoadError } from '@/components/fees/reports/kit';
import { PageGate } from '@/components/page-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth/auth-provider';
import { deviceKeys } from '@/lib/devices/keys';
import type { PeopleFilter } from '@/lib/devices/people';
import { useMeContext } from '@/lib/hooks';

export default function DevicePeoplePage() {
  const t = useTranslations('devices.people');
  const tDevices = useTranslations('devices.devices');
  const { data: context } = useMeContext();
  return (
    <PageGate page="attendance">
      <div className="flex flex-col gap-5">
        <AttendanceTabs active="devices" />
        {isAdminRole(context?.roles) ? (
          <Suspense fallback={<Skeleton className="rounded-card h-96" />}>
            <PeopleScreen />
          </Suspense>
        ) : (
          <>
            <h2 className="text-xl font-semibold sm:text-2xl">{t('title')}</h2>
            <Alert>
              <LockIcon aria-hidden />
              <AlertDescription>{tDevices('adminOnly')}</AlertDescription>
            </Alert>
          </>
        )}
      </div>
    </PageGate>
  );
}

function PeopleScreen() {
  const t = useTranslations('devices.people');
  const params = useSearchParams();
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  // From the live feed: an ID that punched but belongs to nobody (searched for, and explained).
  const unknownParam = toAsciiDigits(params.get('unknown') ?? '').trim();
  const unknown = /^\d{1,9}$/.test(unknownParam) ? unknownParam : null;
  const [filter, setFilter] = useState<PeopleFilter>(() => ({
    kind: 'STUDENT',
    unmappedOnly: false,
    sectionId: '',
    query: unknown ?? '',
  }));
  const [editingId, setEditingId] = useState<string | null>(null);

  const people = useQuery({
    queryKey: deviceKeys.people(tenantId),
    queryFn: () => client.api<DevicePeopleList>('/attendance/device-people'),
  });
  const devices = useQuery({
    queryKey: deviceKeys.list(tenantId),
    queryFn: () => client.api<DeviceList>('/attendance/devices'),
  });
  const activeDevices = devices.data?.devices.filter((d) => d.isActive).length ?? 0;

  /** "Set an ID" from the collisions: show that person alone and open their ID. */
  const setIdFor = (p: DevicePersonRef) => {
    setFilter({
      kind: p.kind,
      unmappedOnly: false,
      sectionId: '',
      query: p.studentCode ?? p.name,
    });
    setEditingId(p.id);
  };

  return (
    <div className="flex flex-col gap-5" data-testid="device-people-page">
      <div className="flex flex-col gap-3">
        <ButtonLink
          variant="ghost"
          size="sm"
          href="/attendance/devices"
          className="-ms-2 self-start"
        >
          <ArrowLeftIcon aria-hidden />
          {t('back')}
        </ButtonLink>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-xl font-semibold sm:text-2xl">{t('title')}</h2>
            <p className="text-muted-foreground max-w-prose">{t('subtitle')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <DefaultIdsButton />
            <SendToDevicesButton devices={devices.data?.devices ?? []} />
            <CsvMenu />
          </div>
        </div>
        {devices.data && activeDevices === 0 && (
          <p className="text-muted-foreground text-sm">{t('noDevices')}</p>
        )}
      </div>

      {unknown && (
        <Alert data-testid="unknown-id">
          <InfoIcon aria-hidden />
          <AlertDescription>
            {t.rich('unknownHint', {
              id: unknown,
              v: () => <Ascii value={unknown} className="font-semibold" />,
            })}
          </AlertDescription>
        </Alert>
      )}

      <CollisionsPanel onSetId={setIdFor} />

      {people.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-11 rounded-full sm:w-2/3" />
          <Skeleton className="rounded-card h-80" />
        </div>
      ) : people.isError ? (
        <LoadError error={people.error} onRetry={() => void people.refetch()} />
      ) : (
        <PeopleList
          data={people.data}
          filter={filter}
          onFilterChange={setFilter}
          editingId={editingId}
          onEditingChange={setEditingId}
          showSync={activeDevices > 0}
        />
      )}

      <StalePanel />
    </div>
  );
}

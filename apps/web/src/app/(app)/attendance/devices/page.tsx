'use client';

import { useQuery } from '@tanstack/react-query';
import type { DeviceList, DeviceView } from '@jantrik/shared';
import { LockIcon, PlusIcon, RouterIcon, UsersIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useRef, useState } from 'react';
import { AttendanceTabs, isAdminRole } from '@/components/attendance/attendance-tabs';
import {
  AddressesDialog,
  FeedControlContext,
  type FeedControl,
} from '@/components/devices/addresses';
import { AlertsStrip } from '@/components/devices/alerts-strip';
import { DeviceFormDialog } from '@/components/devices/device-form';
import { DeviceListView } from '@/components/devices/device-list';
import { LiveFeed, usePunchFeed } from '@/components/devices/punch-feed';
import { SetupGuide } from '@/components/devices/setup-guide';
import { EmptyState, LoadError } from '@/components/fees/reports/kit';
import { PageGate } from '@/components/page-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth/auth-provider';
import { deviceKeys } from '@/lib/devices/keys';
import { useMeContext } from '@/lib/hooks';

/** The list is refreshed this often; every 5 s while a guide waits for its device. */
const LIST_POLL_MS = 30_000;
const GUIDE_POLL_MS = 5_000;

export default function DevicesPage() {
  const t = useTranslations('devices.devices');
  const { data: context } = useMeContext();
  return (
    <PageGate page="attendance">
      <div className="flex flex-col gap-5">
        <AttendanceTabs active="devices" />
        {isAdminRole(context?.roles) ? (
          <DevicesScreen />
        ) : (
          <>
            <h2 className="text-xl font-semibold sm:text-2xl">{t('title')}</h2>
            <Alert>
              <LockIcon aria-hidden />
              <AlertDescription>{t('adminOnly')}</AlertDescription>
            </Alert>
          </>
        )}
      </div>
    </PageGate>
  );
}

function DevicesScreen() {
  const t = useTranslations('devices.devices');
  const { client, session } = useAuth();
  // Dialogs keep the device they opened with; the live row (refetched) is shown when there is one.
  const [guide, setGuide] = useState<DeviceView | null>(null);
  const [addresses, setAddresses] = useState<DeviceView | null>(null);
  const [editing, setEditing] = useState<DeviceView | 'new' | null>(null);
  const [flagged, setFlagged] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  const list = useQuery({
    queryKey: deviceKeys.list(session?.tenant?.id),
    queryFn: () => client.api<DeviceList>('/attendance/devices'),
    // Faster while the setup guide is open on a device that has not connected yet.
    refetchInterval: (query) => {
      if (!guide) return LIST_POLL_MS;
      const d = query.state.data?.devices.find((x) => x.id === guide.id) ?? guide;
      return d.state === 'NEVER_CONNECTED' ? GUIDE_POLL_MS : LIST_POLL_MS;
    },
    refetchIntervalInBackground: false,
  });
  const live = (d: DeviceView | null) =>
    d ? (list.data?.devices.find((x) => x.id === d.id) ?? d) : null;
  const guideDevice = live(guide);

  const feed = usePunchFeed(flagged);
  const { reload } = feed;
  const control = useMemo<FeedControl>(
    () => ({
      reviewFlagged: () => {
        setFlagged(true);
        const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        feedRef.current?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
      },
      reload,
    }),
    [reload],
  );
  const openGuide = (deviceId: string) => {
    const d = list.data?.devices.find((x) => x.id === deviceId);
    if (d) setGuide(d);
  };

  const devices = list.data?.devices;
  return (
    <FeedControlContext.Provider value={control}>
      <div className="flex flex-col gap-5" data-testid="devices-page">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-xl font-semibold sm:text-2xl">{t('title')}</h2>
            <p className="text-muted-foreground max-w-prose">{t('subtitle')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <ButtonLink
              variant="outline"
              href="/attendance/devices/people"
              data-testid="people-link"
            >
              <UsersIcon aria-hidden />
              {t('peopleLink')}
            </ButtonLink>
            <Button onClick={() => setEditing('new')} data-testid="device-add">
              <PlusIcon aria-hidden />
              {t('add')}
            </Button>
          </div>
        </div>

        <AlertsStrip onGuide={openGuide} />

        {list.isPending ? (
          <Skeleton className="rounded-card h-40" />
        ) : list.isError ? (
          <LoadError error={list.error} onRetry={() => void list.refetch()} />
        ) : devices!.length === 0 ? (
          <EmptyState
            icon={RouterIcon}
            title={t('emptyTitle')}
            hint={t('emptyHint')}
            testId="devices-empty"
            action={
              <Button onClick={() => setEditing('new')}>
                <PlusIcon aria-hidden />
                {t('add')}
              </Button>
            }
          />
        ) : (
          <>
            <DeviceListView
              devices={devices!}
              onEdit={setEditing}
              onGuide={setGuide}
              onAddresses={setAddresses}
            />
            <LiveFeed ref={feedRef} feed={feed} flagged={flagged} onFlaggedChange={setFlagged} />
          </>
        )}

        {list.data && (
          <SetupGuide
            device={guideDevice}
            setup={list.data.setup}
            onOpenChange={(open) => !open && setGuide(null)}
          />
        )}
        <AddressesDialog
          device={live(addresses)}
          onOpenChange={(open) => !open && setAddresses(null)}
        />
        {editing !== null && (
          <DeviceFormDialog
            device={editing === 'new' ? 'new' : (live(editing) ?? editing)}
            onOpenChange={(open) => !open && setEditing(null)}
            onCreated={setGuide}
          />
        )}
      </div>
    </FeedControlContext.Provider>
  );
}

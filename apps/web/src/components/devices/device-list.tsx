'use client';

import { useMutation } from '@tanstack/react-query';
import { formatCount, type DeviceSyncResult, type DeviceView } from '@jantrik/shared';
import {
  BookOpenIcon,
  ClockAlertIcon,
  EllipsisVerticalIcon,
  GlobeLockIcon,
  NetworkIcon,
  PencilIcon,
  PowerIcon,
  PowerOffIcon,
  SendIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { DataTable, type DataColumn } from '@/components/data-table';
import { Pill } from '@/components/kit/pill';
import { ConfirmDialog } from '@/components/setup/setup-kit';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useMediaQuery } from '@/lib/media';
import { Ascii, DeviceStatePill, formatSeen, useDevicesError, useInvalidateDevices } from './kit';

export interface DeviceActions {
  onEdit: (device: DeviceView) => void;
  onGuide: (device: DeviceView) => void;
  onAddresses: (device: DeviceView) => void;
}

/** Queue every active person's ID and name for one device; the toast says how many. */
export function useSyncDevice() {
  const t = useTranslations('devices.devices.list');
  const locale = useLocale() as Locale;
  const message = useDevicesError();
  const invalidate = useInvalidateDevices();
  const { client } = useAuth();
  return useMutation({
    mutationFn: (device: DeviceView) =>
      client.api<DeviceSyncResult>(`/attendance/devices/${device.id}/sync`, { method: 'POST' }),
    onSuccess: (r, device) => {
      invalidate();
      const n = {
        name: device.name,
        queued: formatCount(r.queued, locale),
        n: r.queued,
        skipped: formatCount(r.skipped, locale),
        s: r.skipped,
      };
      if (r.queued === 0 && r.skipped === 0) toast.success(t('syncNobody', n));
      else if (r.queued === 0) toast.success(t('syncAllWaiting', n));
      else if (r.skipped > 0) toast.success(t('syncQueuedSkipped', n));
      else toast.success(t('syncQueued', n));
    },
    onError: (e) => toast.error(message(e)),
  });
}

/**
 * The institute's devices: a table at a desk, cards on a phone. Each row has its state, when it
 * was last heard from, the people on it, its waiting and failed commands and a clock warning, and
 * a menu: setup guide, send people, addresses, edit, switch off or on.
 */
export function DeviceListView({ devices, ...actions }: { devices: DeviceView[] } & DeviceActions) {
  const t = useTranslations('devices.devices.list');
  const tDir = useTranslations('devices.devices.direction');
  const locale = useLocale() as Locale;
  const wide = useMediaQuery('(min-width: 1024px)');
  const message = useDevicesError();
  const invalidate = useInvalidateDevices();
  const sync = useSyncDevice();
  const { client } = useAuth();
  const [switchingOff, setSwitchingOff] = useState<DeviceView | null>(null);
  const toggle = useMutation({
    mutationFn: (d: DeviceView) =>
      client.api<DeviceView>(`/attendance/devices/${d.id}`, {
        method: 'PATCH',
        json: { isActive: !d.isActive },
      }),
    onSuccess: (d) => {
      setSwitchingOff(null);
      invalidate();
      toast.success(
        d.isActive ? t('switchedOn', { name: d.name }) : t('switchedOff', { name: d.name }),
      );
    },
    onError: (e) => toast.error(message(e)),
  });
  const f = (n: number) => formatCount(n, locale);
  const where = (d: DeviceView) => [d.gate, tDir(d.direction)].filter(Boolean).join(' · ');

  const menu = (d: DeviceView) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('actions', { name: d.name })}
            data-testid="device-actions"
          >
            <EllipsisVerticalIcon aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onClick={() => actions.onGuide(d)}>
          <BookOpenIcon aria-hidden />
          {t('guide')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => sync.mutate(d)}
          disabled={!d.isActive || sync.isPending}
          data-testid="device-sync"
        >
          <SendIcon aria-hidden />
          {t('sync')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => actions.onAddresses(d)}
          data-testid="device-addresses-open"
        >
          <NetworkIcon aria-hidden />
          {t('addresses')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => actions.onEdit(d)} data-testid="device-edit">
          <PencilIcon aria-hidden />
          {t('edit')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {d.isActive ? (
          <DropdownMenuItem variant="destructive" onClick={() => setSwitchingOff(d)}>
            <PowerOffIcon aria-hidden />
            {t('switchOff')}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => toggle.mutate(d)}>
            <PowerIcon aria-hidden />
            {t('switchOn')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  /** The state, and below it what else is off: the clock, addresses nobody trusted. */
  const state = (d: DeviceView) => (
    <div className="flex flex-col items-start gap-1">
      <DeviceStatePill device={d} />
      {d.clockWarning && d.clockOffsetSec !== null && (
        <Pill tone="warning">
          <ClockAlertIcon aria-hidden className="size-3.5" />
          {t(d.clockOffsetSec > 0 ? 'clockAhead' : 'clockBehind', {
            count: f(Math.round(Math.abs(d.clockOffsetSec) / 60)),
            n: Math.round(Math.abs(d.clockOffsetSec) / 60),
          })}
        </Pill>
      )}
      {d.untrustedAddresses > 0 && (
        <button
          type="button"
          onClick={() => actions.onAddresses(d)}
          className="focus-visible:ring-ring inline-flex min-h-(--touch-min) items-center rounded-full outline-none focus-visible:ring-2"
        >
          <Pill tone="warning">
            <GlobeLockIcon aria-hidden className="size-3.5" />
            {t('untrusted', { count: f(d.untrustedAddresses), n: d.untrustedAddresses })}
          </Pill>
        </button>
      )}
      {d.state === 'NEVER_CONNECTED' && (
        <Button variant="link" size="sm" className="px-0" onClick={() => actions.onGuide(d)}>
          {t('openGuide')}
        </Button>
      )}
    </div>
  );
  const commands = (d: DeviceView) =>
    d.pendingCommands === 0 && d.failedCommands === 0 ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      <span className="flex flex-col items-end gap-1">
        {d.pendingCommands > 0 && (
          <Pill tone="info">{t('pending', { count: f(d.pendingCommands) })}</Pill>
        )}
        {d.failedCommands > 0 && (
          <Pill tone="destructive">{t('failed', { count: f(d.failedCommands) })}</Pill>
        )}
      </span>
    );
  const seen = (iso: string | null) =>
    iso ? formatSeen(iso, locale) : <span className="text-muted-foreground">—</span>;

  const columns: DataColumn<DeviceView>[] = [
    {
      id: 'name',
      header: t('colDevice'),
      cell: (d) => (
        <div className={d.isActive ? undefined : 'text-muted-foreground'}>
          <div className="font-medium">{d.name}</div>
          <div className="text-muted-foreground text-sm">{where(d)}</div>
        </div>
      ),
    },
    {
      id: 'serial',
      header: t('colSerial'),
      cell: (d) => <Ascii value={d.serialNo} mono className="break-all" />,
    },
    { id: 'state', header: t('colState'), cell: state },
    { id: 'seen', header: t('colLastSeen'), cell: (d) => seen(d.lastSeenAt) },
    { id: 'punch', header: t('colLastPunch'), cell: (d) => seen(d.lastPunchAt) },
    {
      id: 'people',
      header: t('colPeople'),
      align: 'end',
      cell: (d) => (d.userCount === null ? '—' : f(d.userCount)),
    },
    { id: 'commands', header: t('colCommands'), align: 'end', cell: commands },
  ];

  return (
    <>
      {wide ? (
        <DataTable
          testId="devices-table"
          caption={t('caption')}
          columns={columns}
          rows={devices}
          rowKey={(d) => d.id}
          rowLabel={(d) => d.name}
          actions={menu}
        />
      ) : (
        <ul
          className="bg-card rounded-card shadow-card flex flex-col divide-y overflow-hidden border"
          data-testid="devices-cards"
        >
          {devices.map((d) => (
            <li key={d.id} className="flex flex-col gap-2 px-4 py-3" data-testid="device-card">
              <div className="flex items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-semibold break-words">{d.name}</span>
                  <span className="text-muted-foreground text-sm">{where(d)}</span>
                  <Ascii
                    value={d.serialNo}
                    mono
                    className="text-muted-foreground text-sm break-all"
                  />
                </div>
                <div className="-me-2 -mt-1 shrink-0">{menu(d)}</div>
              </div>
              {state(d)}
              <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                <dt>{t('colLastSeen')}</dt>
                <dd className="text-foreground">{seen(d.lastSeenAt)}</dd>
                <dt>{t('colLastPunch')}</dt>
                <dd className="text-foreground">{seen(d.lastPunchAt)}</dd>
                <dt>{t('colPeople')}</dt>
                <dd className="text-foreground font-numeric">
                  {d.userCount === null ? '—' : f(d.userCount)}
                </dd>
              </dl>
              {(d.pendingCommands > 0 || d.failedCommands > 0) && (
                <div className="flex flex-wrap gap-1.5">
                  {d.pendingCommands > 0 && (
                    <Pill tone="info">{t('pending', { count: f(d.pendingCommands) })}</Pill>
                  )}
                  {d.failedCommands > 0 && (
                    <Pill tone="destructive">{t('failed', { count: f(d.failedCommands) })}</Pill>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={switchingOff !== null}
        onOpenChange={(open) => !open && setSwitchingOff(null)}
        title={t('switchOffTitle', { name: switchingOff?.name ?? '' })}
        body={t('switchOffBody')}
        confirmLabel={t('switchOffConfirm')}
        pending={toggle.isPending}
        onConfirm={() => switchingOff && toggle.mutate(switchingOff)}
      />
    </>
  );
}

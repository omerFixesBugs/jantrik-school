'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  formatCount,
  type DeviceAddress,
  type DeviceView,
  type TrustAddressResult,
} from '@jantrik/shared';
import { ShieldAlertIcon, ShieldCheckIcon, ShieldOffIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { createContext, useContext, useState } from 'react';
import { toast } from 'sonner';
import { LoadError } from '@/components/fees/reports/kit';
import { Pill } from '@/components/kit/pill';
import { ConfirmDialog } from '@/components/setup/setup-kit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { displayUserName } from '@/lib/names';
import { deviceKeys } from '@/lib/devices/keys';
import { Ascii, formatSeen, useDevicesError, useInvalidateDevices } from './kit';

/** What the devices screen lets its parts do to the live feed (absent elsewhere). */
export interface FeedControl {
  /** Show the flagged punches and bring the feed into view. */
  reviewFlagged: () => void;
  /** Load the feed again from scratch (a trust marks older punches reviewed). */
  reload: () => void;
}
export const FeedControlContext = createContext<FeedControl | null>(null);

/** An address to trust or stop trusting, with the device it belongs to. */
export interface AddressTarget {
  deviceId: string;
  ipId: string;
  ip: string;
}

/**
 * Trust (after a confirm that says what it changes) or revoke (after a confirm that says what
 * stops). Returns the dialogs to render and the functions that open them.
 */
export function useAddressTrust() {
  const t = useTranslations('devices.devices.addresses');
  const locale = useLocale() as Locale;
  const message = useDevicesError();
  const invalidate = useInvalidateDevices();
  const feed = useContext(FeedControlContext);
  const { client } = useAuth();
  const [trusting, setTrusting] = useState<AddressTarget | null>(null);
  const [revoking, setRevoking] = useState<AddressTarget | null>(null);

  const trust = useMutation({
    mutationFn: (a: AddressTarget) =>
      client.api<TrustAddressResult>(`/attendance/devices/${a.deviceId}/ips/${a.ipId}/trust`, {
        method: 'POST',
      }),
    onSuccess: (r) => {
      setTrusting(null);
      toast.success(
        r.reviewedPunches > 0
          ? t('trustedReviewed', {
              ip: r.address.ip,
              count: formatCount(r.reviewedPunches, locale),
              n: r.reviewedPunches,
            })
          : t('trusted', { ip: r.address.ip }),
      );
      invalidate();
      feed?.reload();
    },
    onError: (e) => toast.error(message(e)),
  });
  const revoke = useMutation({
    mutationFn: (a: AddressTarget) =>
      client.api<DeviceAddress>(`/attendance/devices/${a.deviceId}/ips/${a.ipId}/revoke`, {
        method: 'POST',
      }),
    onSuccess: (a) => {
      setRevoking(null);
      toast.success(t('revoked', { ip: a.ip }));
      invalidate();
    },
    onError: (e) => toast.error(message(e)),
  });

  const dialogs = (
    <>
      <ConfirmDialog
        open={trusting !== null}
        onOpenChange={(open) => !open && setTrusting(null)}
        title={t('trustTitle', { ip: trusting?.ip ?? '' })}
        body={t('trustBody')}
        confirmLabel={t('trust')}
        destructive={false}
        pending={trust.isPending}
        onConfirm={() => trusting && trust.mutate(trusting)}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t('revokeTitle', { ip: revoking?.ip ?? '' })}
        body={t('revokeBody')}
        confirmLabel={t('revoke')}
        pending={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
      />
    </>
  );
  return { askTrust: setTrusting, askRevoke: setRevoking, dialogs };
}

/** A device's addresses: when each was seen, its punches, and whether commands may go there. */
export function useDeviceAddresses(deviceId: string | null) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: deviceKeys.ips(session?.tenant?.id, deviceId ?? ''),
    queryFn: () => client.api<DeviceAddress[]>(`/attendance/devices/${deviceId}/ips`),
    enabled: deviceId !== null,
  });
}

/** Trusted automatically, trusted by someone, or not trusted: icon and words. */
export function TrustState({ address }: { address: DeviceAddress }) {
  const t = useTranslations('devices.devices.addresses');
  const locale = useLocale() as Locale;
  if (!address.trusted) {
    return (
      <Pill tone="warning">
        <ShieldAlertIcon aria-hidden className="size-3.5" />
        {t('untrusted')}
      </Pill>
    );
  }
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
      <ShieldCheckIcon aria-hidden className="text-success size-4 shrink-0" />
      {address.trustedBy === 'automatic' || address.trustedBy === null
        ? t('trustedAutomatic')
        : t('trustedBy', {
            name: displayUserName(address.trustedBy, locale),
            when: formatSeen(address.trustedAt!, locale),
          })}
    </span>
  );
}

/** The addresses a device called from, with trust and revoke. */
export function AddressesDialog({
  device,
  onOpenChange,
}: {
  device: DeviceView | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('devices.devices.addresses');
  const locale = useLocale() as Locale;
  const addresses = useDeviceAddresses(device?.id ?? null);
  const { askTrust, askRevoke, dialogs } = useAddressTrust();
  const f = (n: number) => formatCount(n, locale);
  return (
    <>
      <Dialog open={device !== null} onOpenChange={onOpenChange}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
          data-testid="device-addresses"
        >
          <DialogHeader>
            <DialogTitle>{t('title', { name: device?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          {addresses.isPending ? (
            <Skeleton className="h-24 rounded-lg" />
          ) : addresses.isError ? (
            <LoadError error={addresses.error} onRetry={() => void addresses.refetch()} />
          ) : addresses.data.length === 0 ? (
            <p className="text-muted-foreground">{t('none')}</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {addresses.data.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center"
                  data-testid="device-address"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <Ascii value={a.ip} mono className="font-semibold break-all" />
                    <span className="text-muted-foreground text-sm">
                      {t('seen', {
                        first: formatSeen(a.firstSeenAt, locale),
                        last: formatSeen(a.lastSeenAt, locale),
                      })}
                      {' · '}
                      {t('punches', { count: f(a.punchCount), n: a.punchCount })}
                    </span>
                    <TrustState address={a} />
                  </div>
                  {device &&
                    (a.trusted ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="self-start sm:self-center"
                        onClick={() => askRevoke({ deviceId: device.id, ipId: a.id, ip: a.ip })}
                        data-testid="address-revoke"
                      >
                        <ShieldOffIcon aria-hidden />
                        {t('revoke')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="self-start sm:self-center"
                        onClick={() => askTrust({ deviceId: device.id, ipId: a.id, ip: a.ip })}
                        data-testid="address-trust"
                      >
                        <ShieldCheckIcon aria-hidden />
                        {t('trust')}
                      </Button>
                    ))}
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
      {dialogs}
    </>
  );
}

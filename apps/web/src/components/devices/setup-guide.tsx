'use client';

import type { DeviceList, DeviceView } from '@jantrik/shared';
import { formatCount } from '@jantrik/shared';
import {
  CircleCheckIcon,
  CopyIcon,
  LanguagesIcon,
  LoaderCircleIcon,
  PowerOffIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  WifiOffIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { Locale } from '@/i18n/config';
import { guideAddress } from '@/lib/devices/addresses';
import { cn } from '@/lib/utils';
import { TrustState, useAddressTrust, useDeviceAddresses } from './addresses';
import { Ascii, copyText, formatSeen } from './kit';

/** An IPv4 or IPv6 address (the device's "domain name" switch stays off for these). */
const isIpAddress = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');

/** A value to type into the device: ASCII, monospace, easy to read off the screen. */
const value = (chunks: ReactNode) => (
  <span
    dir="ltr"
    className="bg-muted rounded px-1 py-0.5 font-mono text-[0.92em] font-semibold whitespace-nowrap"
  >
    {chunks}
  </span>
);

/**
 * How to point a ZKTeco device at us, Bangla first: the server and port to copy, the device's menu
 * steps, and a line that turns from "waiting for the device…" to "connected" by itself (the page
 * polls the list every 5 s while this is open and the device has not connected). Once connected it
 * shows the device's trusted address, or while none is trusted the latest untrusted one with when
 * it was seen and its punches, and asks whether it is the institute's own (`guideAddress`).
 */
export function SetupGuide({
  device,
  setup,
  onOpenChange,
}: {
  device: DeviceView | null;
  setup: DeviceList['setup'];
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('devices.devices.guide');
  const locale = useLocale() as Locale;
  const port = String(setup.port);
  const steps: ReactNode[] = device
    ? [
        t('step1'),
        t.rich('step2', { v: value }),
        t.rich('step3', { host: setup.host, port, v: value }),
        isIpAddress(setup.host)
          ? t.rich('step4Ip', { v: value })
          : t.rich('step4Domain', { v: value }),
        t.rich('step5', { v: value }),
        t.rich('step6', { v: value }),
        ...(device.direction === 'BOTH' ? [t.rich('step7Both', { v: value })] : []),
        t.rich('step8', { serial: device.serialNo, v: value }),
        t('step9'),
      ]
    : [];
  return (
    <Sheet open={device !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        // The sheet sizes itself per side; a phone gets the whole width, a desk a wider panel.
        className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
        data-testid="setup-guide"
      >
        <SheetHeader className="pe-12">
          <SheetTitle className="text-lg">{t('title', { name: device?.name ?? '' })}</SheetTitle>
          <SheetDescription>{t('description')}</SheetDescription>
        </SheetHeader>
        {device && (
          <div className="flex flex-col gap-5 px-4 pb-6">
            <div aria-live="polite">
              <GuideStatus device={device} />
            </div>

            <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 rounded-lg border p-3">
              <CopyRow label={t('server')} text={setup.host} testId="guide-host" />
              <CopyRow label={t('port')} text={port} testId="guide-port" />
              <dt className="text-muted-foreground text-sm">{t('serial')}</dt>
              <dd className="col-span-2 min-w-0" data-testid="guide-serial">
                <Ascii value={device.serialNo} mono className="font-semibold wrap-anywhere" />
              </dd>
            </dl>

            <ol className="flex flex-col gap-3">
              {steps.map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span
                    aria-hidden
                    className="bg-primary-soft text-primary-ink font-numeric flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                  >
                    {formatCount(i + 1, locale)}
                  </span>
                  <span className="min-w-0 pt-0.5 leading-relaxed">{step}</span>
                </li>
              ))}
            </ol>

            <p className="text-muted-foreground flex gap-2 text-sm">
              <LanguagesIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
              {t('namesInEnglish')}
            </p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function CopyRow({ label, text, testId }: { label: string; text: string; testId: string }) {
  const t = useTranslations('devices.devices.guide');
  return (
    <>
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="min-w-0" data-testid={testId}>
        <Ascii value={text} mono className="font-semibold wrap-anywhere" />
      </dd>
      <dd>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('copy', { label })}
          onClick={() => void copyText(text, t('copied'), t('copyFailed'))}
        >
          <CopyIcon aria-hidden />
        </Button>
      </dd>
    </>
  );
}

/**
 * Switched off, waiting for its first call, online now, or offline now (it has called before); a
 * device that has called shows its address (`guideAddress`, never the latest caller as such) and
 * whether it is ours.
 */
function GuideStatus({ device }: { device: DeviceView }) {
  const t = useTranslations('devices.devices.guide');
  const tAddress = useTranslations('devices.devices.addresses');
  const locale = useLocale() as Locale;
  const seen = device.lastSeenAt !== null;
  const online = device.state === 'ONLINE';
  const addresses = useDeviceAddresses(seen ? device.id : null);
  const { askTrust, askRevoke, dialogs } = useAddressTrust();

  if (!device.isActive) {
    return (
      <p
        className="bg-muted flex items-start gap-3 rounded-lg px-3 py-3"
        data-testid="guide-status"
      >
        <PowerOffIcon aria-hidden className="text-muted-foreground mt-0.5 size-5 shrink-0" />
        {t('inactive')}
      </p>
    );
  }
  if (!seen) {
    return (
      <div
        className="bg-info-soft flex items-start gap-3 rounded-lg px-3 py-3"
        data-testid="guide-status"
        data-state="waiting"
      >
        <LoaderCircleIcon aria-hidden className="text-info mt-0.5 size-5 shrink-0 animate-spin" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{t('waiting')}</span>
          <span className="text-muted-foreground text-sm">{t('waitingHint')}</span>
        </div>
      </div>
    );
  }
  const address = addresses.data ? guideAddress(addresses.data) : null;
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg px-3 py-3',
        online ? 'bg-success-soft' : 'bg-warning-soft',
      )}
      data-testid="guide-status"
      data-state={online ? 'connected' : 'offline'}
    >
      <div className="flex items-start gap-3">
        {online ? (
          <CircleCheckIcon aria-hidden className="text-success mt-0.5 size-5 shrink-0" />
        ) : (
          <WifiOffIcon aria-hidden className="text-warning mt-0.5 size-5 shrink-0" />
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className={cn('font-medium', online ? 'text-success' : 'text-warning')}>
            {online ? t('connected') : t('offline')}
          </span>
          <span className="text-muted-foreground text-sm">
            {t('lastSeen', { when: formatSeen(device.lastSeenAt!, locale) })}
          </span>
          {!online && <span className="text-muted-foreground text-sm">{t('offlineHint')}</span>}
        </div>
      </div>
      {address && (
        <div
          className="bg-card flex flex-col gap-2 rounded-md border p-3"
          data-testid="guide-address"
        >
          <p className="text-sm">{t.rich('fromAddress', { ip: address.ip, v: value })}</p>
          <TrustState address={address} />
          <p className="text-muted-foreground text-sm">
            {tAddress('seen', {
              first: formatSeen(address.firstSeenAt, locale),
              last: formatSeen(address.lastSeenAt, locale),
            })}
            {' · '}
            {tAddress('punches', {
              count: formatCount(address.punchCount, locale),
              n: address.punchCount,
            })}
          </p>
          <p className="text-muted-foreground text-sm">
            {address.trusted ? t('notOursHint') : t('trustHint')}
          </p>
          <div>
            {address.trusted ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => askRevoke({ deviceId: device.id, ipId: address.id, ip: address.ip })}
                data-testid="guide-revoke"
              >
                <ShieldOffIcon aria-hidden />
                {t('notOurs')}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => askTrust({ deviceId: device.id, ipId: address.id, ip: address.ip })}
              >
                <ShieldCheckIcon aria-hidden />
                {t('ours')}
              </Button>
            )}
          </div>
        </div>
      )}
      {dialogs}
    </div>
  );
}

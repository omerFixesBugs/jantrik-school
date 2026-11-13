'use client';

import { useQuery } from '@tanstack/react-query';
import type { DeviceAlert } from '@jantrik/shared';
import { BookOpenIcon, ListChecksIcon, ShieldCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useContext } from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import { cn } from '@/lib/utils';
import { FeedControlContext, useAddressTrust } from './addresses';
import { useAlertText } from './alert-text';
import { ALERTS_POLL_MS, deviceKeys } from '@/lib/devices/keys';

const TONE = {
  destructive: 'border-destructive/30 bg-destructive-soft',
  warning: 'border-warning/40 bg-warning-soft',
  info: 'border-info/30 bg-info-soft',
} as const;
const ICON_TONE = {
  destructive: 'text-destructive',
  warning: 'text-warning',
  info: 'text-info',
} as const;

const alertKey = (a: DeviceAlert): string =>
  a.kind === 'NEW_IP' ? `${a.kind}:${a.ipId}` : `${a.kind}:${a.deviceId}`;

/** The device alerts, polled while the screen is visible. */
export function useDeviceAlerts(enabled = true, poll = true) {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: deviceKeys.alerts(session?.tenant?.id),
    queryFn: () => client.api<DeviceAlert[]>('/attendance/devices/alerts'),
    enabled,
    refetchInterval: poll ? ALERTS_POLL_MS : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * What needs the admin's eye on the devices, worst first, each with one line on what to do. Nothing
 * when all is well (the device list says so); a failed load is quiet too (the list shows errors).
 */
export function AlertsStrip({ onGuide }: { onGuide: (deviceId: string) => void }) {
  const t = useTranslations('devices.devices.alerts');
  const alerts = useDeviceAlerts();
  const text = useAlertText();
  const feed = useContext(FeedControlContext);
  const { askTrust, dialogs } = useAddressTrust();
  if (!alerts.data || alerts.data.length === 0) return null;
  const now = new Date();
  return (
    <section aria-label={t('title')} className="flex flex-col gap-2" data-testid="device-alerts">
      <ul className="flex flex-col gap-2">
        {alerts.data.map((a) => {
          const { title, help, icon: Icon, tone } = text(a, now);
          return (
            <li
              key={alertKey(a)}
              className={cn(
                'flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between',
                TONE[tone],
              )}
              data-testid="device-alert"
              data-kind={a.kind}
            >
              <div className="flex min-w-0 gap-3">
                <Icon aria-hidden className={cn('mt-0.5 size-5 shrink-0', ICON_TONE[tone])} />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium break-words">{title}</span>
                  <span className="text-muted-foreground text-sm">{help}</span>
                </div>
              </div>
              {a.kind === 'NEW_IP' && (
                <div className="flex shrink-0 flex-wrap gap-2 ps-8 sm:ps-0">
                  <Button
                    onClick={() => askTrust({ deviceId: a.deviceId, ipId: a.ipId, ip: a.ip })}
                    data-testid="alert-trust"
                  >
                    <ShieldCheckIcon aria-hidden />
                    {t('trust')}
                  </Button>
                  {feed && (
                    <Button
                      variant="outline"
                      onClick={feed.reviewFlagged}
                      data-testid="alert-review"
                    >
                      <ListChecksIcon aria-hidden />
                      {t('review')}
                    </Button>
                  )}
                </div>
              )}
              {a.kind === 'HELD' && feed && (
                <Button
                  variant="outline"
                  className="ms-8 shrink-0 self-start sm:ms-0 sm:self-center"
                  onClick={feed.reviewFlagged}
                >
                  <ListChecksIcon aria-hidden />
                  {t('review')}
                </Button>
              )}
              {a.kind === 'OFFLINE' && a.state === 'NEVER_CONNECTED' && (
                <Button
                  variant="outline"
                  className="ms-8 shrink-0 self-start sm:ms-0 sm:self-center"
                  onClick={() => onGuide(a.deviceId)}
                >
                  <BookOpenIcon aria-hidden />
                  {t('guide')}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {dialogs}
    </section>
  );
}

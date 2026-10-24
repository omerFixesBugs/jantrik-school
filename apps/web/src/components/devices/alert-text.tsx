'use client';

import { formatCount, formatTime, type DeviceAlert } from '@jantrik/shared';
import {
  CirclePauseIcon,
  ClockAlertIcon,
  GlobeLockIcon,
  PlugZapIcon,
  WavesIcon,
  WifiOffIcon,
  type LucideIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback } from 'react';
import type { PillTone } from '@/components/kit/pill';
import type { Locale } from '@/i18n/config';
import { elapsed } from '@/lib/devices/feed';
import { useDuration } from './kit';

export interface AlertText {
  /** One line: what happened ("প্রধান ফটক ২৫ মিনিট ধরে অফলাইন"). */
  title: string;
  /** One line: what to do about it. */
  help: string;
  icon: LucideIcon;
  tone: Extract<PillTone, 'destructive' | 'warning' | 'info'>;
}

/**
 * A device alert in words. The API sends them worst first (offline, new address, flood, held,
 * clock), and both the devices screen and the dashboard keep that order.
 */
export function useAlertText() {
  const t = useTranslations('devices.devices.alerts');
  const locale = useLocale() as Locale;
  const duration = useDuration();
  return useCallback(
    (alert: DeviceAlert, now = new Date()): AlertText => {
      const device = alert.deviceName;
      switch (alert.kind) {
        case 'OFFLINE':
          return alert.state === 'NEVER_CONNECTED'
            ? {
                title: t('neverTitle', { device }),
                help: t('neverHelp', { duration: duration(elapsed(alert.since, now)) }),
                icon: PlugZapIcon,
                tone: 'warning',
              }
            : {
                title: t('offlineTitle', { device, duration: duration(elapsed(alert.since, now)) }),
                help: t('offlineHelp'),
                icon: WifiOffIcon,
                tone: 'destructive',
              };
        case 'NEW_IP':
          return {
            title: t('newIpTitle', {
              device,
              ip: alert.ip,
              count: formatCount(alert.punchCount, locale),
              n: alert.punchCount,
            }),
            help: t('newIpHelp'),
            icon: GlobeLockIcon,
            tone: 'warning',
          };
        case 'FLOOD':
          return {
            title: t('floodTitle', {
              device,
              time: formatTime(alert.at, locale),
              count: formatCount(alert.dropped, locale),
              n: alert.dropped,
            }),
            help: t('floodHelp'),
            icon: WavesIcon,
            tone: 'warning',
          };
        case 'HELD':
          return {
            title: t('heldTitle', {
              device,
              count: formatCount(alert.count, locale),
              n: alert.count,
            }),
            help: t('heldHelp'),
            icon: CirclePauseIcon,
            tone: 'warning',
          };
        case 'CLOCK':
          return {
            title: t(alert.ahead ? 'clockAheadTitle' : 'clockBehindTitle', {
              device,
              count: formatCount(alert.minutes, locale),
              n: alert.minutes,
            }),
            help: t('clockHelp'),
            icon: ClockAlertIcon,
            tone: 'info',
          };
      }
    },
    [t, locale, duration],
  );
}

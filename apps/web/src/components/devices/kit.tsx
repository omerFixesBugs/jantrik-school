'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  DEVICE_IMPORT_MAX_ROWS,
  formatCount,
  formatDayMonth,
  formatTime,
  localDateOf,
  type DevicePersonRef,
  type DeviceView,
  type PunchPerson,
} from '@jantrik/shared';
import { PlugZapIcon, PowerOffIcon, WifiIcon, WifiOffIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { Pill } from '@/components/kit/pill';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { elapsed, type Elapsed } from '@/lib/devices/feed';
import { useErrorMessage } from '@/lib/hooks';
import { displayName } from '@/lib/names';
import { cn } from '@/lib/utils';

/*
 * Pieces the devices screen, the people screen and the dashboard card share: error text for the
 * devices API's codes, the device state pill, durations and names.
 */

const TIME_ZONE = 'Asia/Dhaka';

/** A person from the people API in the UI language. */
export const refName = (ref: DevicePersonRef, locale: Locale): string =>
  locale === 'bn' ? (ref.nameBn ?? ref.name) : ref.name;

/** Error text for the devices and device-people APIs; other errors as everywhere. */
export function useDevicesError() {
  const t = useTranslations('devices.devices.errors');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  return useCallback(
    (error: unknown): string => {
      if (error instanceof ApiError) {
        const body = error.body as
          { holder?: DevicePersonRef | null; previous?: DevicePersonRef | null } | null | undefined;
        switch (error.code) {
          case 'SERIAL_TAKEN':
          case 'SERIAL_LOCKED':
          case 'DEVICE_INACTIVE':
          case 'NOT_HELD':
          case 'NOT_STAFF':
          case 'PERSON_ACTIVE':
          case 'FILE_MISSING':
          case 'FILE_TYPE':
          case 'FILE_INVALID':
          case 'FILE_EMPTY':
          case 'MISSING_COLUMNS':
          case 'NO_DATA_ROWS':
          // 409 while the institute's punches are being processed: the same action again soon.
          case 'BUSY':
            return t(error.code);
          case 'TOO_MANY_ROWS':
            return t('TOO_MANY_ROWS', { max: formatCount(DEVICE_IMPORT_MAX_ROWS, locale) });
          case 'DEVICE_ID_TAKEN':
            return body?.holder
              ? t('DEVICE_ID_TAKEN', { name: refName(body.holder, locale) })
              : t('DEVICE_ID_TAKEN_UNKNOWN');
          // A device still has someone else under this ID (their finger would punch as the new
          // holder): they are removed from the devices first.
          case 'ID_STILL_ON_DEVICE':
            return body?.previous
              ? t('ID_STILL_ON_DEVICE', { name: refName(body.previous, locale) })
              : t('ID_STILL_ON_DEVICE_UNKNOWN');
        }
        if (error.status === 413) return t('FILE_TOO_LARGE');
        if (error.status === 404) return t('notFound');
        if (error.status === 400) return t('invalid');
      }
      return describe(error);
    },
    [t, locale, describe],
  );
}

/** After a device change: the list, its alerts and the people's sync states. */
export function useInvalidateDevices() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    for (const key of [
      'attendance-devices',
      'attendance-device-alerts',
      'attendance-device-ips',
      'attendance-device-people',
    ])
      void queryClient.invalidateQueries({ queryKey: [key] });
  }, [queryClient]);
}

/** "২৫ মিনিট" / "3 hours". */
export function useDuration() {
  const t = useTranslations('devices.devices.duration');
  const locale = useLocale() as Locale;
  return useCallback(
    (e: Elapsed) => t(e.unit, { count: formatCount(e.value, locale), n: e.value }),
    [t, locale],
  );
}

/** A moment shown as its time today, or day, month and time on another day. */
export function formatSeen(iso: string, locale: Locale, now = new Date()): string {
  const time = formatTime(iso, locale);
  return localDateOf(new Date(iso), TIME_ZONE) === localDateOf(now, TIME_ZONE)
    ? time
    : `${formatDayMonth(iso, locale)}, ${time}`;
}

/** A serial number, address or device ID: ASCII digits, left to right, never translated. */
export function Ascii({
  value,
  mono = false,
  className,
}: {
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <span
      dir="ltr"
      className={cn('tabular-nums', mono && 'font-mono text-[0.92em] tracking-wide', className)}
    >
      {value}
    </span>
  );
}

/** Online, offline for how long, not connected yet, or switched off: icon and words. */
export function DeviceStatePill({ device }: { device: DeviceView }) {
  const t = useTranslations('devices.devices.state');
  const duration = useDuration();
  switch (device.state) {
    case 'ONLINE':
      return (
        <Pill tone="success">
          <WifiIcon aria-hidden className="size-3.5" />
          {t('ONLINE')}
        </Pill>
      );
    case 'OFFLINE':
      return (
        <Pill tone="destructive">
          <WifiOffIcon aria-hidden className="size-3.5" />
          {device.lastSeenAt
            ? t('OFFLINE_FOR', { duration: duration(elapsed(device.lastSeenAt, new Date())) })
            : t('OFFLINE')}
        </Pill>
      );
    case 'NEVER_CONNECTED':
      return (
        <Pill tone="info">
          <PlugZapIcon aria-hidden className="size-3.5" />
          {t('NEVER_CONNECTED')}
        </Pill>
      );
    case 'INACTIVE':
      return (
        <Pill tone="neutral">
          <PowerOffIcon aria-hidden className="size-3.5" />
          {t('INACTIVE')}
        </Pill>
      );
  }
}

/** Who punched: the name and, below it, the class and section or "staff". */
export function usePunchPerson() {
  const t = useTranslations('devices.devices.feed');
  const locale = useLocale() as Locale;
  return useCallback(
    (person: PunchPerson): { name: string; detail: string; code?: string } => {
      if (person.kind === 'STAFF') {
        return {
          name: (locale === 'bn' ? (person.nameBn ?? person.name) : person.name) || '—',
          detail: t('staff'),
        };
      }
      const place = person.classLevel
        ? [
            displayName(person.classLevel.nameBn, person.classLevel.nameEn, locale),
            person.section?.name,
          ]
            .filter(Boolean)
            .join(', ')
        : t('notEnrolled');
      return {
        name: displayName(person.nameBn, person.nameEn, locale) || '—',
        detail: place,
        code: person.studentCode,
      };
    },
    [t, locale],
  );
}

/** Copy a value (an address, a port) and say so. */
export async function copyText(value: string, done: string, failed: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(done);
  } catch {
    toast.error(failed);
  }
}

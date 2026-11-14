'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatCount,
  formatWallClock,
  type AttendanceSettings,
  type CloseFromDeviceResult,
  type SectionDeviceToday,
  type SectionRef,
} from '@jantrik/shared';
import { FingerprintIcon, TriangleAlertIcon, UsersIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/setup/setup-kit';
import { Button } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel } from '@/lib/hooks';
import { bnGenitive, displayName } from '@/lib/names';

/*
 * A section's day by device on the today page: arrivals so far before the cutoff, or why the
 * cutoff held the register back, and for owners and admins "take it from the device".
 */

/** The today report's device view of a section. */
export type DeviceDay = SectionDeviceToday;

/** Every state but these is a register held back at its cutoff, a new reason included. */
export const isHeldBack = (device: DeviceDay | null): boolean =>
  !!device && device.state !== 'BEFORE_CUTOFF' && device.state !== 'CLOSED';

/** Before the cutoff: "ডিভাইসে প্রবেশ ২৮/৩৫ · দেরি ৩ · সময়সীমা সকাল ৯:০০". */
export function DeviceProgress({ device }: { device: DeviceDay }) {
  const t = useTranslations('reports');
  const locale = useLocale() as Locale;
  const parts = [
    t('deviceArrived', {
      arrived: formatCount(device.arrived, locale),
      enrolled: formatCount(device.enrolled, locale),
    }),
    ...(device.late > 0 ? [t('deviceLate', { count: formatCount(device.late, locale) })] : []),
    t('deviceCutoff', { time: formatWallClock(device.cutoffAt, locale) }),
  ];
  return (
    <p
      className="text-muted-foreground flex items-start gap-1.5 text-sm"
      data-testid="device-progress"
    >
      <FingerprintIcon aria-hidden className="text-info mt-0.5 size-4 shrink-0" />
      <span className="font-numeric min-w-0">{parts.join(' · ')}</span>
    </p>
  );
}

/**
 * Why the cutoff did not write the register; teachers take it by hand. Owners and admins also get
 * the way to the section's students without an ID (the people screen is theirs only).
 */
export function DeviceHeldBack({
  device,
  sectionId,
  isAdmin,
}: {
  device: DeviceDay;
  sectionId: string;
  isAdmin: boolean;
}) {
  const t = useTranslations('reports');
  const locale = useLocale() as Locale;
  const time = formatWallClock(device.cutoffAt, locale);
  const reason = (() => {
    switch (device.state) {
      case 'NOT_ON_DEVICE':
        // Giving IDs is for owners and admins only (the people screen is theirs).
        return t(isAdmin ? 'deviceNotOnDeviceAdmin' : 'deviceNotOnDevice', {
          count: formatCount(device.notOnDevice, locale),
          n: device.notOnDevice,
        });
      case 'DEVICE_OFFLINE':
        return t('deviceOffline', { time });
      case 'TOO_MANY_MISSING':
        return t('deviceTooManyMissing', { time });
      case 'AUTO_CLOSE_ENDED':
        return t('deviceAutoCloseEnded', { time });
      default:
        return t('deviceHeldBack', { time });
    }
  })();
  return (
    <div
      className="border-warning/40 bg-warning-soft flex flex-col gap-2 rounded-lg border p-3 text-sm"
      data-testid="device-held-back"
      data-state={device.state}
    >
      <p className="flex items-start gap-2">
        <TriangleAlertIcon aria-hidden className="text-warning mt-0.5 size-4 shrink-0" />
        <span className="min-w-0">{reason}</span>
      </p>
      <DeviceProgress device={device} />
      {device.state === 'NOT_ON_DEVICE' && isAdmin && (
        <Link
          href={`/attendance/devices/people?${new URLSearchParams({ unmapped: '1', section: sectionId })}`}
          data-testid="device-give-ids"
          className="text-link flex min-h-(--control-h-xs) w-fit items-center gap-1.5 font-medium hover:underline"
        >
          <UsersIcon aria-hidden className="size-4" />
          {t('deviceGiveIds')}
        </Link>
      )}
    </div>
  );
}

/**
 * Owners and admins: write the held-back register from the punches after a confirm that says
 * what will happen (who is present, late, absent, and whether guardians get the absent SMS).
 */
export function CloseFromDevice({ section, device }: { section: SectionRef; device: DeviceDay }) {
  const t = useTranslations('reports');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const tenantId = session?.tenant?.id;
  const [open, setOpen] = useState(false);
  // Whether the absent SMS is on, for the confirm (the settings page's query).
  const settings = useQuery({
    queryKey: ['attendance-settings', tenantId],
    queryFn: () => client.api<AttendanceSettings>('/attendance/settings'),
    enabled: open,
  });
  const refresh = () => {
    for (const k of [
      'attendance-report-today',
      'attendance-summary',
      'attendance-trend',
      'attendance-my-sections',
      'sms-today',
    ])
      void queryClient.invalidateQueries({ queryKey: [k] });
  };
  // "this section" for English, the Bangla genitive ("এই শাখার") for Bangla.
  const sectionWords = {
    section: label('section', 'Section', { inText: true }),
    sectionOf: bnGenitive(label('section', 'শাখা')),
  };
  const close = useMutation({
    mutationFn: () =>
      client.api<CloseFromDeviceResult>(`/attendance/sections/${section.id}/close-from-device`, {
        method: 'POST',
      }),
    onSuccess: (r) => {
      setOpen(false);
      refresh();
      toast.success(
        t('closeDone', {
          present: formatCount(r.counts.present, locale),
          late: formatCount(r.counts.late, locale),
          absent: formatCount(r.counts.absent, locale),
        }),
      );
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        switch (e.code) {
          // The punch lock is busy for a moment: the dialog stays open to try again.
          case 'BUSY':
            return toast.error(t('busy'));
          case 'BEFORE_CUTOFF': {
            const at = (e.body as { cutoffAt?: string } | undefined)?.cutoffAt ?? device.cutoffAt;
            toast.error(t('closeBEFORE_CUTOFF', { time: formatWallClock(at, locale) }));
            break;
          }
          case 'REGISTER_EXISTS':
          case 'NO_STUDENTS':
            toast.error(t(`close${e.code}`, sectionWords));
            break;
          case 'NON_WORKING_DAY':
          case 'WRONG_PERIOD_FOR_MODE':
            toast.error(t(`close${e.code}`));
            break;
          default:
            return toast.error(describe(e));
        }
        // The report no longer matches the server: show what is there now.
        setOpen(false);
        refresh();
        return;
      }
      toast.error(describe(e));
    },
  });

  const name = `${displayName(section.classLevel.nameBn, section.classLevel.nameEn, locale)}, ${section.name}`;
  const absent = Math.max(0, device.enrolled - device.arrived);
  const sms = settings.data ? (settings.data.absentSmsEnabled ? 'on' : 'off') : 'other';
  const body = [
    t('closeBody', {
      name,
      present: formatCount(Math.max(0, device.arrived - device.late), locale),
      late: formatCount(device.late, locale),
      absent: formatCount(absent, locale),
      sms,
    }),
    ...(device.notOnDevice
      ? [
          t('closeNotOnDevice', {
            count: formatCount(device.notOnDevice, locale),
            n: device.notOnDevice,
          }),
        ]
      : []),
  ].join(' ');
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} data-testid="close-from-device">
        <FingerprintIcon aria-hidden />
        {t('closeFromDevice')}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('closeTitle')}
        body={body}
        confirmLabel={t('closeConfirm')}
        pending={close.isPending}
        destructive={false}
        onConfirm={() => close.mutate()}
      />
    </>
  );
}

'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  formatCount,
  formatTime,
  type StaffDayRecord,
  type StaffDayState,
  type StaffDayStatus,
  type StaffRole,
} from '@jantrik/shared';
import {
  CalendarOffIcon,
  CheckIcon,
  ClockAlertIcon,
  HourglassIcon,
  LogOutIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { Pill, type PillTone } from '@/components/kit/pill';
import { Badge } from '@/components/ui/badge';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useErrorMessage } from '@/lib/hooks';

/*
 * Pieces the staff day and month views share: query keys, error text, a person's name and roles,
 * a day's status as icon and word, late and early minutes, and times.
 */

export const staffKeys = {
  day: (tenantId: string | undefined, date: string) => ['staff-attendance-day', tenantId, date],
  month: (tenantId: string | undefined, month: string) => [
    'staff-attendance-month',
    tenantId,
    month,
  ],
};

/** After a manual entry or a tracked switch: every day and month shown again. */
export function useInvalidateStaffAttendance() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    for (const key of ['staff-attendance-day', 'staff-attendance-month'])
      void queryClient.invalidateQueries({ queryKey: [key] });
  }, [queryClient]);
}

/** Error text for the staff attendance API's codes; other errors as everywhere. */
export function useStaffAttendanceError() {
  const t = useTranslations('staffAttendance.common.errors');
  const describe = useErrorMessage();
  return useCallback(
    (error: unknown): string => {
      if (error instanceof ApiError) {
        switch (error.code) {
          case 'FUTURE_DATE':
          case 'NOT_STAFF':
          case 'IN_TIME_REQUIRED':
          case 'OUT_BEFORE_IN':
          case 'BUSY':
            return t(error.code);
        }
      }
      return describe(error);
    },
    [t, describe],
  );
}

/** A staff member's name in the UI language (profiles keep an optional Bangla name). */
export const staffName = (p: { name: string; nameBn: string | null }, locale: Locale): string =>
  (locale === 'bn' ? (p.nameBn ?? p.name) : p.name) || '—';

/** "শিক্ষক", "প্রশাসক"… as small badges. */
export function RoleBadges({ roles }: { roles: StaffRole[] }) {
  const t = useTranslations('roles');
  return roles.map((r) => (
    <Badge key={r} variant={r === 'OWNER' ? 'warm' : 'soft'}>
      {t(r)}
    </Badge>
  ));
}

/** A time of day as shown, wrapping as one piece ("সকাল ৮:১২"). */
export const timeText = (iso: string, locale: Locale): string =>
  formatTime(iso, locale).replace(' ', ' ');

const STATUS: Record<StaffDayStatus, { icon: LucideIcon; tone: PillTone }> = {
  PRESENT: { icon: CheckIcon, tone: 'success' },
  ABSENT: { icon: XIcon, tone: 'destructive' },
  LEAVE: { icon: CalendarOffIcon, tone: 'neutral' },
};
const STATE: Record<StaffDayState, { icon: LucideIcon; tone: PillTone } | null> = {
  ABSENT: { icon: XIcon, tone: 'destructive' },
  NOT_YET: { icon: HourglassIcon, tone: 'info' },
  OFF: { icon: CalendarOffIcon, tone: 'neutral' },
  NONE: null,
};

/** A stored day's status, or what a day without one is; icon and word, never colour alone. */
export function DayStatusPill({
  status,
  state,
}: {
  status: StaffDayStatus | null;
  state: StaffDayState | null;
}) {
  const t = useTranslations('staffAttendance.common');
  if (status) {
    const { icon: Icon, tone } = STATUS[status];
    return (
      <Pill tone={tone} className="text-sm">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        {t(`status.${status}`)}
      </Pill>
    );
  }
  const look = state ? STATE[state] : null;
  if (!look) return <span className="text-muted-foreground text-sm">{t('state.NONE')}</span>;
  const Icon = look.icon;
  return (
    <Pill tone={look.tone} className="text-sm">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {t(`state.${state!}`)}
    </Pill>
  );
}

/** "দেরি ১২ মি." and "আগে গেছেন ৫ মি." for a present day, nothing otherwise. */
export function MinutesPills({
  day,
}: {
  day: Pick<StaffDayRecord, 'lateMinutes' | 'earlyMinutes'>;
}) {
  const t = useTranslations('staffAttendance.common');
  const locale = useLocale() as Locale;
  return (
    <>
      {day.lateMinutes > 0 && (
        <Pill tone="warning" className="font-numeric">
          <ClockAlertIcon aria-hidden className="size-3.5 shrink-0" />
          <span aria-hidden>{t('late', { minutes: formatCount(day.lateMinutes, locale) })}</span>
          <span className="sr-only">
            {t('lateLabel', { minutes: formatCount(day.lateMinutes, locale) })}
          </span>
        </Pill>
      )}
      {day.earlyMinutes > 0 && (
        <Pill tone="warning" className="font-numeric">
          <LogOutIcon aria-hidden className="size-3.5 shrink-0" />
          <span aria-hidden>{t('early', { minutes: formatCount(day.earlyMinutes, locale) })}</span>
          <span className="sr-only">
            {t('earlyLabel', { minutes: formatCount(day.earlyMinutes, locale) })}
          </span>
        </Pill>
      )}
    </>
  );
}

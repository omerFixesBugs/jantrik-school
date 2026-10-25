'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  addDays,
  formatCount,
  formatWallClock,
  type IsoDate,
  type StaffDayPerson,
  type StaffDayReport,
  type StaffTrackedResult,
} from '@jantrik/shared';
import {
  CalendarOffIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EllipsisVerticalIcon,
  FingerprintIcon,
  PencilLineIcon,
  RouterIcon,
  UsersIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { SourceTag } from '@/components/attendance/source-tag';
import { DateInput } from '@/components/date-input';
import { EmptyState, LoadError } from '@/components/fees/reports/kit';
import { Pill } from '@/components/kit/pill';
import { PersonAvatar } from '@/components/person-avatar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { displayUserName } from '@/lib/names';
import { cn } from '@/lib/utils';
import { EntryDialog } from './entry-dialog';
import {
  DayStatusPill,
  MinutesPills,
  RoleBadges,
  staffKeys,
  staffName,
  timeText,
  useInvalidateStaffAttendance,
  useStaffAttendanceError,
} from './kit';

/**
 * One row's columns from 768 px: the person, the day, in, out, late/early and source, actions.
 * Under it the row stacks: the person and the actions, then the day in one wrapping line.
 */
const ROW_GRID =
  'md:grid-cols-[minmax(12rem,1.4fr)_minmax(7rem,0.8fr)_minmax(6.5rem,0.6fr)_minmax(6.5rem,0.6fr)_minmax(10rem,1.2fr)_auto]';

/** Everyone's day: date picker (no future dates), office hours, the list, manual entry. */
export function StaffDayView({
  date,
  today,
  onDate,
}: {
  date: IsoDate;
  today: IsoDate;
  onDate: (date: IsoDate) => void;
}) {
  const t = useTranslations('staffAttendance');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const [entering, setEntering] = useState<StaffDayPerson | null>(null);
  const report = useQuery({
    queryKey: staffKeys.day(session?.tenant?.id, date),
    queryFn: () => client.api<StaffDayReport>(`/staff-attendance/day?date=${date}`),
  });
  const r = report.data;

  return (
    <div className="flex flex-col gap-4" data-testid="staff-day">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-end gap-1" role="group" aria-label={t('day.date')}>
          <Button
            variant="outline"
            size="icon"
            aria-label={t('day.prev')}
            onClick={() => onDate(addDays(date, -1))}
          >
            <ChevronLeftIcon aria-hidden />
          </Button>
          <DateInput
            id="staff-day-date"
            aria-label={t('day.date')}
            className="w-40"
            value={date}
            max={today}
            onValueChange={(d) => d && d <= today && onDate(d)}
            data-testid="staff-day-date"
          />
          <Button
            variant="outline"
            size="icon"
            aria-label={t('day.next')}
            disabled={date >= today}
            onClick={() => onDate(addDays(date, 1))}
          >
            <ChevronRightIcon aria-hidden />
          </Button>
          {date !== today && (
            <Button variant="ghost" onClick={() => onDate(today)}>
              {t('day.today')}
            </Button>
          )}
        </div>
        {r && (
          <p className="text-muted-foreground text-sm">
            <span className="font-numeric">
              {t('day.officeHours', {
                start: formatWallClock(r.officeHours.start, locale),
                end: formatWallClock(r.officeHours.end, locale),
                late: formatCount(r.officeHours.lateGraceMinutes, locale),
                early: formatCount(r.officeHours.earlyGraceMinutes, locale),
              })}
            </span>{' '}
            <Link
              href="/attendance/settings#settings-staff"
              className="text-link font-medium hover:underline"
            >
              {t('day.officeHoursChange')}
            </Link>
          </p>
        )}
      </div>

      {report.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="rounded-card h-72" />
        </div>
      ) : report.isError ? (
        <LoadError error={report.error} onRetry={() => void report.refetch()} />
      ) : r!.people.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title={t('common.noStaffTitle')}
          hint={t('common.noStaffHint')}
          testId="staff-empty"
          action={
            <ButtonLink variant="outline" href="/staff">
              {t('common.staffLink')}
            </ButtonLink>
          }
        />
      ) : (
        <>
          {r!.nonWorkingDay && (
            <Alert>
              <CalendarOffIcon aria-hidden />
              <AlertDescription>
                {r!.nonWorkingDay.reason === 'HOLIDAY'
                  ? `${t('common.state.OFF')}: ${locale === 'bn' ? r!.nonWorkingDay.nameBn : r!.nonWorkingDay.nameEn}`
                  : t('common.state.OFF')}
              </AlertDescription>
            </Alert>
          )}
          {!r!.nonWorkingDay && noDeviceData(r!) && (
            <Alert data-testid="staff-no-punches">
              <RouterIcon aria-hidden />
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span className="max-w-prose">{t('day.noPunchesDay')}</span>
                <ButtonLink size="sm" variant="outline" href="/attendance/devices">
                  {t('common.devicesLink')}
                </ButtonLink>
              </AlertDescription>
            </Alert>
          )}
          <DaySummary report={r!} />
          <section
            data-slot="card"
            aria-label={t('day.listLabel')}
            className="bg-card rounded-card shadow-card overflow-hidden border"
          >
            <div
              aria-hidden
              className={cn(
                'text-muted-foreground hidden gap-x-3 border-b px-4 py-2 text-sm font-medium md:grid',
                ROW_GRID,
              )}
            >
              <span>{t('month.colName')}</span>
              <span>{t('day.entryStatus')}</span>
              <span>{t('day.in')}</span>
              <span>{t('day.out')}</span>
              <span />
              <span />
            </div>
            <ul className="divide-y" data-testid="staff-day-list">
              {r!.people.map((p) => (
                <PersonRow key={p.userId} person={p} onEnter={() => setEntering(p)} />
              ))}
            </ul>
          </section>
        </>
      )}
      {entering && r && (
        <EntryDialog person={entering} date={r.date} onClose={() => setEntering(null)} />
      )}
    </div>
  );
}

/** Nobody punched and nothing came from a device: the devices may not be set up. */
const noDeviceData = (r: StaffDayReport) =>
  r.people.every((p) => p.punches.length === 0 && p.day?.source !== 'DEVICE');

/** Counts of the day among the people whose attendance is kept. */
function DaySummary({ report }: { report: StaffDayReport }) {
  const t = useTranslations('staffAttendance.day');
  const locale = useLocale() as Locale;
  const c = { present: 0, late: 0, absent: 0, leave: 0, notYet: 0 };
  for (const p of report.people) {
    if (p.day?.status === 'PRESENT') {
      c.present += 1;
      if (p.day.lateMinutes > 0) c.late += 1;
    } else if (p.day?.status === 'LEAVE') c.leave += 1;
    else if (p.day?.status === 'ABSENT' || p.state === 'ABSENT') c.absent += 1;
    else if (p.state === 'NOT_YET') c.notYet += 1;
  }
  const items = [
    { key: 'summaryPresent', n: c.present, tone: 'success' },
    { key: 'summaryLate', n: c.late, tone: 'warning' },
    { key: 'summaryAbsent', n: c.absent, tone: 'destructive' },
    { key: 'summaryLeave', n: c.leave, tone: 'neutral' },
    { key: 'summaryNotYet', n: c.notYet, tone: 'info' },
  ] as const;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={t('summary')} data-testid="staff-summary">
      {items
        .filter((i) => i.n > 0 || i.key !== 'summaryNotYet')
        .map((i) => (
          <li key={i.key}>
            <Pill tone={i.tone} className="font-numeric text-sm">
              {t(i.key, { count: formatCount(i.n, locale) })}
            </Pill>
          </li>
        ))}
    </ul>
  );
}

function PersonRow({ person: p, onEnter }: { person: StaffDayPerson; onEnter: () => void }) {
  const t = useTranslations('staffAttendance');
  const locale = useLocale() as Locale;
  const [open, setOpen] = useState(false);
  const name = staffName(p, locale);
  const day = p.day;
  const present = day?.status === 'PRESENT';
  const isStaff = p.roles.length > 0;
  const ownerOnly = p.roles.length > 0 && p.roles.every((r) => r === 'OWNER');
  const punchesId = `staff-punches-${p.userId}`;
  return (
    <li
      className={cn(
        'grid grid-cols-[1fr_auto] items-start gap-x-3 gap-y-2 px-3 py-3 md:items-center md:px-4',
        ROW_GRID,
        !p.tracked && !day && 'bg-muted/40',
      )}
      data-testid="staff-day-row"
      data-user-id={p.userId}
    >
      <div className="flex min-w-0 items-start gap-3">
        <PersonAvatar name={name} size="sm" className="mt-0.5 shrink-0" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-semibold break-words">{name}</span>
          <span className="flex flex-wrap items-center gap-1">
            <RoleBadges roles={p.roles} />
            {!isStaff && <Pill tone="neutral">{t('day.notStaff')}</Pill>}
          </span>
          {!p.tracked && (
            <span className="text-muted-foreground text-xs" data-testid="staff-untracked">
              {ownerOnly && p.trackedSetting === null
                ? t('day.untrackedOwner')
                : t('day.untracked')}
            </span>
          )}
        </div>
      </div>

      {/* The day: one wrapping line on a phone, its own columns from 768 px. */}
      <div className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm md:contents">
        <div>
          <DayStatusPill status={day?.status ?? null} state={p.state} />
        </div>
        <div className="font-numeric">
          <span className="text-muted-foreground md:sr-only">{t('day.in')} </span>
          {present && day.inAt ? timeText(day.inAt, locale) : <Dash />}
        </div>
        <div className="font-numeric">
          <span className="text-muted-foreground md:sr-only">{t('day.out')} </span>
          {present && day.outAt ? (
            timeText(day.outAt, locale)
          ) : present ? (
            <span className="text-muted-foreground" title={t('day.noOut')}>
              —<span className="sr-only">{t('day.noOut')}</span>
            </span>
          ) : (
            <Dash />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {day && <MinutesPills day={day} />}
          {day && <SourceTag source={day.source} />}
        </div>
      </div>

      <div className="col-start-2 row-start-1 flex items-center gap-1 md:col-start-auto md:row-start-auto">
        {isStaff && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={onEnter}
              aria-label={t('day.enterFor', { name })}
              data-testid="staff-enter"
            >
              <PencilLineIcon aria-hidden />
              <span className="hidden sm:inline">{t('day.enter')}</span>
            </Button>
            <TrackedMenu person={p} name={name} />
          </>
        )}
      </div>

      {(day?.source === 'MANUAL' || p.punches.length > 0) && (
        <div className="col-span-full flex flex-col gap-1.5 text-sm md:ps-11">
          {day?.source === 'MANUAL' && (
            <p className="text-muted-foreground break-words">
              {day.reason && t('common.reason', { reason: day.reason })}
              {day.updatedBy.id && (
                <>
                  {day.reason && ' · '}
                  {t('day.enteredBy', { name: displayUserName(day.updatedBy, locale) })}
                </>
              )}
            </p>
          )}
          {p.punches.length > 0 && (
            <>
              <button
                type="button"
                className="text-link flex min-h-(--control-h-xs) w-fit items-center gap-1 font-medium hover:underline"
                aria-expanded={open}
                aria-controls={punchesId}
                onClick={() => setOpen((o) => !o)}
              >
                <ChevronDownIcon
                  aria-hidden
                  className={cn('size-4 transition-transform', open && 'rotate-180')}
                />
                {open
                  ? t('day.punchesHide')
                  : t('day.punchesShow', { count: formatCount(p.punches.length, locale) })}
              </button>
              {open && (
                <ul
                  id={punchesId}
                  aria-label={t('day.punchesTitle')}
                  className="flex flex-wrap gap-1.5"
                  data-testid="staff-punches"
                >
                  {p.punches.map((punch, i) => (
                    <li
                      key={`${punch.punchedAt}-${i}`}
                      className="bg-canvas inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5"
                    >
                      <FingerprintIcon aria-hidden className="text-info size-3.5 shrink-0" />
                      <span className="font-numeric">{timeText(punch.punchedAt, locale)}</span>
                      <span className="text-muted-foreground">· {punch.deviceName}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

const Dash = () => <span className="text-muted-foreground">—</span>;

/** Keep this person's attendance: on, off, or the default rule (owners alone are not kept). */
function TrackedMenu({ person: p, name }: { person: StaffDayPerson; name: string }) {
  const t = useTranslations('staffAttendance.day');
  const { client } = useAuth();
  const describe = useStaffAttendanceError();
  const invalidate = useInvalidateStaffAttendance();
  const save = useMutation({
    mutationFn: (tracked: boolean | null) =>
      client.api<StaffTrackedResult>(`/staff-attendance/${p.userId}/tracked`, {
        method: 'PUT',
        json: { tracked },
      }),
    onSuccess: () => {
      invalidate();
      toast.success(t('trackedSaved'));
    },
    onError: (e) => toast.error(describe(e)),
  });
  const value = p.trackedSetting === null ? 'default' : p.trackedSetting ? 'on' : 'off';
  // What the default rule gives this person now (only someone who is only the owner is left out).
  const byDefault = p.roles.some((r) => r !== 'OWNER');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('actions', { name })}
            data-testid="staff-row-menu"
            disabled={save.isPending}
          >
            <EllipsisVerticalIcon aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => {
            if (v === value) return;
            save.mutate(v === 'default' ? null : v === 'on');
          }}
        >
          <DropdownMenuLabel>{t('tracked')}</DropdownMenuLabel>
          <DropdownMenuRadioItem value="on" data-testid="tracked-on">
            {t('trackedOn')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="off" data-testid="tracked-off">
            {t('trackedOff')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="default" data-testid="tracked-default">
            {t('trackedDefault', { now: byDefault ? t('trackedNowOn') : t('trackedNowOff') })}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs leading-snug font-normal whitespace-normal">
            {t('defaultRule')}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

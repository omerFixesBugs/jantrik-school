'use client';

import {
  ATTENDANCE_TARGET,
  attendancePercent,
  formatCount,
  formatDate,
  formatDayMonth,
  formatIdentifier,
  LONG_ABSENCE_DAYS,
  periodPercent,
  splitPeriods,
  type AttendanceCounts,
  type AttendanceTodayReport,
  type AttendanceTrendReport,
} from '@jantrik/shared';
import { ChevronRightIcon, PhoneIcon, TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { registerHref } from '@/components/attendance/section-picker';
import { TrendChart, type TrendPoint } from '@/components/charts';
import { SegmentedControl } from '@/components/kit/segmented-control';
import { SectionBoard, type BoardSection } from '@/components/section-board';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useLabel } from '@/lib/hooks';
import { displayName } from '@/lib/names';
import { cn } from '@/lib/utils';

/*
 * Attendance on the dashboard (docs/design.md → Dashboards): the section board (today, this week
 * or the last 30 days), who is absent and whom to call, and the trend against the period before
 * and the target. Choosing a class on the board narrows the absentees and the trend to that class
 * (the chosen series burns brightest).
 */

/** Absent this many school days running or more: worth a call. */
export const LONG_ABSENCE = LONG_ABSENCE_DAYS;

export type BoardPeriod = 'today' | 'week' | 'month';
const PERIOD_DAYS = { week: 7, month: 30 } as const;

export function Panel({
  title,
  aside,
  children,
  className,
  testId,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      data-slot="card"
      className={cn(
        'bg-card rounded-card shadow-card flex flex-col gap-3 border p-(--panel-p)',
        className,
      )}
      data-testid={testId}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function PanelLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="text-link focus-visible:ring-ring inline-flex min-h-(--control-h-xs) items-center gap-0.5 rounded text-sm font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2"
    >
      {children}
      <ChevronRightIcon aria-hidden className="size-4 rtl:rotate-180" />
    </Link>
  );
}

// ─────────────────────────── The board ───────────────────────────

export function TodayBoard({
  report,
  history,
  historyFailed = false,
  onRetryHistory,
  period = 'today',
  onPeriodChange,
  classId,
  onClassChange,
}: {
  report: AttendanceTodayReport;
  /** The last 60 days by section (the week and month views); undefined while it loads. */
  history?: AttendanceTrendReport;
  /** The 60 days could not be loaded (the week and month views say so, with a retry). */
  historyFailed?: boolean;
  onRetryHistory?: () => void;
  period?: BoardPeriod;
  onPeriodChange?: (period: BoardPeriod) => void;
  classId: string | null;
  onClassChange: (classId: string | null) => void;
}) {
  const t = useTranslations('dashboard');
  const tBoard = useTranslations('board');
  const tAtt = useTranslations('attendance');
  const tCommon = useTranslations('common');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const section = label('section', 'Section', { inText: true });
  const classLevel = label('class_level', 'Class', { inText: true });
  const f = (n: number) => formatCount(n, locale);

  // Each section's present %: today's register, or the week's or month's days added up.
  const lines = new Map((history?.sections ?? []).map((l) => [l.section.id, l.days]));
  const percentOf = (id: string, today: number | null): number | null => {
    if (period === 'today') return today;
    const days = lines.get(id);
    if (!days || !history) return null;
    const { current } = splitPeriods(days, history.today, PERIOD_DAYS[period]);
    return periodPercent(current, history.leaveCountsAsAbsent);
  };
  const sections: BoardSection[] = report.sections.map((s) => {
    const percent = percentOf(s.section.id, s.register?.percent ?? null);
    return {
      section: s.section,
      percent,
      display: percent === null ? '' : `${f(Math.round(percent))}%`,
    };
  });
  const waiting = period !== 'today' && !history;
  const title =
    period === 'today'
      ? tBoard('label', { section })
      : t(period === 'week' ? 'boardTitleWeek' : 'boardTitleMonth', { section });
  const registerPeriod = (id: string) =>
    report.sections.find((s) => s.section.id === id)?.register?.periodNo ??
    (report.mode === 'PER_SESSION' ? 1 : 0);
  const day = report.nonWorkingDay;

  return (
    <Panel
      testId="today-board"
      title={title}
      aside={
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {onPeriodChange && report.sections.length > 0 && (
            <SegmentedControl
              value={period}
              onChange={onPeriodChange}
              label={`${title}: ${t('periodLabel')}`}
              testId="board-period"
              options={[
                { value: 'today', label: t('periodToday') },
                { value: 'week', label: t('periodWeek') },
                { value: 'month', label: t('periodMonth') },
              ]}
            />
          )}
          <PanelLink href="/attendance/today">{t('boardOpen')}</PanelLink>
        </div>
      }
    >
      {day && period === 'today' && (
        <p className="text-muted-foreground text-sm">
          {day.reason === 'HOLIDAY'
            ? tAtt('holiday', { name: locale === 'bn' ? day.nameBn : day.nameEn })
            : tAtt('offDay')}
        </p>
      )}
      {sections.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t('boardEmpty', { section })}{' '}
          <Link href="/setup/classes" className="text-link underline-offset-2 hover:underline">
            {t('stepSections', { classLevel, section })}
          </Link>
        </p>
      ) : waiting && historyFailed ? (
        <p className="text-muted-foreground flex flex-wrap items-center gap-3 text-sm">
          {t('loadFailed')}
          {onRetryHistory && (
            <button
              type="button"
              onClick={onRetryHistory}
              className="text-link focus-visible:ring-ring min-h-(--control-h-xs) rounded font-medium underline underline-offset-2 outline-none focus-visible:ring-2"
            >
              {tCommon('retry')}
            </button>
          )}
        </p>
      ) : waiting ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : (
        <SectionBoard
          sections={sections}
          href={(s) => registerHref(s.section.id, registerPeriod(s.section.id))}
          legend={[
            `< ${f(88)}`,
            `${f(88)}–${f(90)}`,
            `${f(91)}–${f(93)}`,
            `${f(94)}–${f(96)}`,
            `${f(97)}+`,
          ]}
          selectedClass={classId}
          onSelectClass={onClassChange}
        />
      )}
    </Panel>
  );
}

// ─────────────────────────── Absentees ───────────────────────────

export function TodayAbsentees({
  report,
  classId,
}: {
  report: AttendanceTodayReport;
  classId: string | null;
}) {
  const t = useTranslations('dashboard');
  const tReports = useTranslations('reports');
  const tStudents = useTranslations('students');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const sectionLabel = label('section', 'Section');
  const rows = report.sections
    .filter((s) => !classId || s.section.classLevel.id === classId)
    .flatMap((s) => (s.register?.absent ?? []).map((st) => ({ ...st, section: s.section })))
    // Longest absences first; otherwise class, section and roll order (the sort is stable).
    .sort((a, b) => b.streak - a.streak);
  const shown = rows.slice(0, 8);
  const taken = report.sections.some(
    (s) => s.register && (!classId || s.section.classLevel.id === classId),
  );

  return (
    <Panel
      testId="today-absentees"
      title={t('absentTitle')}
      aside={
        rows.length > shown.length && (
          <PanelLink href="/attendance/today">
            {t('absentAll', { count: formatCount(rows.length, locale) })}
          </PanelLink>
        )
      }
    >
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {taken ? t('absentNone') : t('absentNotYet')}
        </p>
      ) : (
        <ul className="-my-1 flex flex-col divide-y">
          {shown.map((st) => {
            const name = displayName(st.nameBn, st.nameEn, locale);
            const place = [
              displayName(st.section.classLevel.nameBn, st.section.classLevel.nameEn, locale),
              `${sectionLabel} ${st.section.name}`,
            ].join(' · ');
            return (
              <li key={st.id} className="flex items-center gap-2 py-1" data-testid="absentee">
                <Link
                  href={`/attendance/students/${st.id}`}
                  aria-label={tReports('openStudent', { name })}
                  className="hover:bg-muted/60 focus-visible:ring-ring -mx-1.5 flex min-h-(--control-h) min-w-0 flex-1 flex-col justify-center rounded-md px-1.5 outline-none focus-visible:ring-2"
                >
                  {/* The name gives way first: the streak chip always shows whole. */}
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate font-medium">{name}</span>
                    {st.streak >= 2 && <Streak days={st.streak} />}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {place}
                    {st.roll != null && (
                      <>
                        {' · '}
                        {tStudents('roll')}{' '}
                        <span className="tabular-nums">{formatIdentifier(st.roll)}</span>
                      </>
                    )}
                  </span>
                </Link>
                {st.guardianPhone && (
                  <a
                    href={`tel:${st.guardianPhone}`}
                    className={buttonVariants({
                      variant: 'outline',
                      size: 'icon',
                      className: 'shrink-0',
                    })}
                    aria-label={tReports('callGuardian', { name })}
                  >
                    <PhoneIcon aria-hidden />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/** "Absent 3 days running": a shape and a word, never colour alone. */
function Streak({ days }: { days: number }) {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const long = days >= LONG_ABSENCE;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 text-xs leading-6 font-medium whitespace-nowrap',
        long ? 'bg-warning-soft text-warning' : 'bg-muted text-muted-foreground',
      )}
    >
      {long && <TriangleAlertIcon aria-hidden className="size-3.5" />}
      {t('streak', { count: formatCount(days, locale), n: days })}
    </span>
  );
}

// ─────────────────────────── The last 30 days ───────────────────────────

/** The trend's points: all sections, or the chosen class's sections added up. */
export function trendPoints(
  report: AttendanceTrendReport,
  classId: string | null,
  text: {
    detail: (present: number, total: number) => string;
    offDay: string;
    holiday: (day: { nameBn: string; nameEn: string }) => string;
    notTaken: string;
  },
): TrendPoint[] {
  const lines = classId ? report.sections.filter((s) => s.section.classLevel.id === classId) : null;
  return report.days.map((d, i) => {
    let counts: AttendanceCounts | null = d.counts;
    if (lines) {
      const taken = lines.flatMap((l) => l.days[i]?.counts ?? []);
      counts =
        taken.length === 0
          ? null
          : taken.reduce((a, c) => ({
              present: a.present + c.present,
              absent: a.absent + c.absent,
              late: a.late + c.late,
              leave: a.leave + c.leave,
            }));
    }
    const value = counts ? attendancePercent(counts, report.leaveCountsAsAbsent) : null;
    const total = counts
      ? counts.present +
        counts.absent +
        counts.late +
        (report.leaveCountsAsAbsent ? counts.leave : 0)
      : 0;
    const off = d.nonWorkingDay;
    return {
      key: d.date,
      value,
      detail: counts ? text.detail(counts.present + counts.late, total) : undefined,
      note: off ? (off.reason === 'HOLIDAY' ? text.holiday(off) : text.offDay) : text.notTaken,
      // A day off with no register: in the table, not on the line.
      rest: Boolean(off) && value === null,
    };
  });
}

/**
 * Present % over the last week or 30 days (all sections, or the chosen class), the same days of
 * the period before as a dashed ghost, and the target line. `report` holds both periods (60
 * days).
 */
export function AttendanceTrend({
  report,
  classId,
  period = 'month',
  onPeriodChange,
  className,
}: {
  report: AttendanceTrendReport;
  classId: string | null;
  period?: 'week' | 'month';
  onPeriodChange?: (period: 'week' | 'month') => void;
  className?: string;
}) {
  const t = useTranslations('dashboard');
  const tReports = useTranslations('reports');
  const locale = useLocale() as Locale;
  const f = (n: number) => formatCount(n, locale);
  const all = trendPoints(report, classId, {
    detail: (present, total) => t('trendDetail', { present: f(present), total: f(total) }),
    offDay: tReports('offDay'),
    holiday: (h) => t('trendHoliday', { name: locale === 'bn' ? h.nameBn : h.nameEn }),
    notTaken: t('trendNotTaken'),
  });
  const length = PERIOD_DAYS[period];
  const { current, previous } = splitPeriods(
    report.days.map((d, i) => ({ date: d.date, i })),
    report.today,
    length,
  );
  const points = current.map((c) => all[c.i]!);
  // The k-th school day of this period meets the k-th of the one before (aligned from the end
  // when the year began inside the earlier period); days off have no ghost.
  const school = (list: { i: number }[]) => list.filter((c) => !all[c.i]!.rest);
  const nowDays = school(current);
  const thenDays = school(previous);
  const offset = nowDays.length - thenDays.length;
  const ghostOf = new Map(
    nowDays.map((c, k) => [
      c.i,
      k - offset >= 0 ? (all[thenDays[k - offset]!.i]!.value ?? null) : null,
    ]),
  );
  const ghost = current.map((c) => ghostOf.get(c.i) ?? null);
  const chosen = classId
    ? report.sections.find((s) => s.section.classLevel.id === classId)?.section.classLevel
    : null;
  const title = chosen
    ? t('trendTitleClass', {
        name: displayName(chosen.nameBn, chosen.nameEn, locale),
        days: f(points.length),
      })
    : t('trendTitle', { days: f(points.length) });
  return (
    <Panel
      title={title}
      className={className}
      testId="attendance-trend"
      aside={
        onPeriodChange && (
          <SegmentedControl
            value={period}
            onChange={onPeriodChange}
            label={`${title}: ${t('periodLabel')}`}
            testId="trend-period"
            options={[
              { value: 'week', label: t('periodWeek') },
              { value: 'month', label: t('periodMonth') },
            ]}
          />
        )
      }
    >
      <TrendChart
        points={points}
        title={title}
        height={190}
        formatValue={(v) => `${f(Math.round(v))}%`}
        formatKey={(k) => formatDate(k, locale, 'full')}
        formatAxis={(k) => formatDayMonth(k, locale)}
        tone={chosen ? 'sky' : 'accent'}
        currentLabel={t('trendCurrent', { days: f(length) })}
        previous={
          ghost.some((v) => v !== null)
            ? { values: ghost, label: t('trendPrevious', { days: f(length) }) }
            : undefined
        }
        target={{
          value: ATTENDANCE_TARGET,
          label: t('trendTarget', { target: f(ATTENDANCE_TARGET) }),
        }}
      />
    </Panel>
  );
}

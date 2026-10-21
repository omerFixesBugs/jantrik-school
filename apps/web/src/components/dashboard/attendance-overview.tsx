'use client';

import {
  attendancePercent,
  formatCount,
  formatDate,
  formatDayMonth,
  formatIdentifier,
  percentDomain,
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
import { SectionBoard, type BoardSection } from '@/components/section-board';
import { buttonVariants } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { useLabel } from '@/lib/hooks';
import { displayName } from '@/lib/names';
import { cn } from '@/lib/utils';

/*
 * Today's attendance on the dashboard (docs/design.md → Dashboards): the section board, who is
 * absent and whom to call, and the last 30 days. Choosing a class on the board narrows the
 * absentees and the trend to that class (the chosen series burns brightest).
 */

/** Absent this many school days running or more: worth a call. */
export const LONG_ABSENCE = 3;

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
      className={cn('bg-card flex flex-col gap-3 rounded-lg border p-(--panel-p)', className)}
      data-testid={testId}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">{title}</h2>
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
  classId,
  onClassChange,
}: {
  report: AttendanceTodayReport;
  classId: string | null;
  onClassChange: (classId: string | null) => void;
}) {
  const t = useTranslations('dashboard');
  const tBoard = useTranslations('board');
  const tAtt = useTranslations('attendance');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const section = label('section', 'Section', { inText: true });
  const classLevel = label('class_level', 'Class', { inText: true });
  const f = (n: number) => formatCount(n, locale);

  const sections: BoardSection[] = report.sections.map((s) => {
    const percent = s.register?.percent ?? null;
    return {
      section: s.section,
      percent,
      display: percent === null ? '' : `${f(Math.round(percent))}%`,
    };
  });
  const period = (id: string) =>
    report.sections.find((s) => s.section.id === id)?.register?.periodNo ??
    (report.mode === 'PER_SESSION' ? 1 : 0);
  const day = report.nonWorkingDay;

  return (
    <Panel
      testId="today-board"
      title={tBoard('label', { section })}
      aside={<PanelLink href="/attendance/today">{t('boardOpen')}</PanelLink>}
    >
      {day && (
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
      ) : (
        <SectionBoard
          sections={sections}
          href={(s) => registerHref(s.section.id, period(s.section.id))}
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
    };
  });
}

export function AttendanceTrend({
  report,
  classId,
  className,
}: {
  report: AttendanceTrendReport;
  classId: string | null;
  className?: string;
}) {
  const t = useTranslations('dashboard');
  const tReports = useTranslations('reports');
  const locale = useLocale() as Locale;
  const f = (n: number) => formatCount(n, locale);
  const points = trendPoints(report, classId, {
    detail: (present, total) => t('trendDetail', { present: f(present), total: f(total) }),
    offDay: tReports('offDay'),
    holiday: (h) => t('trendHoliday', { name: locale === 'bn' ? h.nameBn : h.nameEn }),
    notTaken: t('trendNotTaken'),
  });
  const chosen = classId
    ? report.sections.find((s) => s.section.classLevel.id === classId)?.section.classLevel
    : null;
  const title = chosen
    ? t('trendTitleClass', {
        name: displayName(chosen.nameBn, chosen.nameEn, locale),
        days: f(report.days.length),
      })
    : t('trendTitle', { days: f(report.days.length) });
  return (
    <Panel title={title} className={className} testId="attendance-trend">
      <TrendChart
        points={points}
        title={title}
        height={170}
        domain={percentDomain(points.map((p) => p.value))}
        formatValue={(v) => `${f(Math.round(v))}%`}
        formatKey={(k) => formatDate(k, locale, 'full')}
        formatAxis={(k) => formatDayMonth(k, locale)}
        tone={chosen ? 'sky' : 'mint'}
      />
    </Panel>
  );
}

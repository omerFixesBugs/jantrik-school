'use client';

import {
  formatCount,
  formatDate,
  LONG_ABSENCE_DAYS,
  toBanglaDigits,
  typicalExamMarks,
  yearProgress,
  type AttentionItem,
  type InsightFact,
  type MeContext,
  type StudentsSummary,
} from '@jantrik/shared';
import {
  BellRingIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  MessageSquareWarningIcon,
  PhoneCallIcon,
  SparklesIcon,
  TrendingDownIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Panel } from '@/components/dashboard/attendance-overview';
import { DeltaPill } from '@/components/kit/pill';
import { BarList } from '@/components/charts';
import { Donut } from '@/components/story-charts';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useLabel } from '@/lib/hooks';
import { displayName } from '@/lib/names';
import { cn } from '@/lib/utils';

/*
 * The principal's dashboard (docs/design.md → Dashboards): today in one line, what needs them
 * first, where the year stands, who the students are. The numbers come from the reports the page
 * already loads; @jantrik/shared decides what to say (dashboardInsight, attentionItems), this
 * file says it.
 */

/**
 * Renders its children once they come near the viewport (charts below the fold), a sized
 * skeleton until then, so the first screen's work is only the first screen. `onVisible` starts
 * the data the children need.
 */
export function Deferred({
  height,
  children,
  onVisible,
}: {
  height: number;
  children: ReactNode;
  onVisible?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Without IntersectionObserver (old browsers) everything renders at once.
  const [near, setNear] = useState(
    () => typeof window !== 'undefined' && !('IntersectionObserver' in window),
  );
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          observer.disconnect();
          setNear(true);
        }
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);
  useEffect(() => {
    if (near) onVisible?.();
  }, [near, onVisible]);
  return near ? (
    <>{children}</>
  ) : (
    <div ref={ref}>
      <Skeleton className="rounded-card w-full" style={{ height }} />
    </div>
  );
}

// ───────────────────────────── The insight ─────────────────────────────

/** Today in one line: the facts dashboardInsight chose, in the institute's words. */
export function useInsightText() {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const f = (n: number) => formatCount(n, locale);
  const section = label('section', 'Section', { inText: true });
  const classLevel = label('class_level', 'Class', { inText: true });
  return (facts: InsightFact[]) =>
    facts
      .map((fact) => {
        switch (fact.kind) {
          case 'coverage':
            return t('insightCoverage', { taken: f(fact.taken), total: f(fact.total), section });
          case 'allTaken':
            return t('insightAllTaken', { section });
          case 'present':
            return t('insightPresent', { present: f(fact.present), counted: f(fact.counted) });
          case 'call':
            return t('insightCall', { count: f(fact.count), n: fact.count });
          case 'week':
            return t(fact.change > 0 ? 'insightWeekUp' : 'insightWeekDown', {
              change: formatCount(Math.abs(fact.change), locale),
            });
          case 'dayOff':
            return fact.name ? t('insightHoliday', { name: fact.name }) : t('insightDayOff');
          case 'setup':
            return t('insightSetup', { classLevel, section });
        }
      })
      .join(' · ');
}

// ───────────────────────────── Needs attention ─────────────────────────────

const ATTENTION_ICON = {
  longAbsence: PhoneCallIcon,
  heldSms: MessageSquareWarningIcon,
  notTaken: ClipboardListIcon,
  belowTarget: TrendingDownIcon,
  setup: SparklesIcon,
} as const;

/** What needs the principal first, most urgent first; a calm line when all is well. */
export function AttentionCard({
  items,
  sectionName,
  setupStep,
  target,
}: {
  items: AttentionItem[];
  sectionName: (id: string) => string;
  setupStep: { title: string; href: string } | null;
  target: number;
}) {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const f = (n: number) => formatCount(n, locale);
  const section = label('section', 'Section', { inText: true });
  const row = (item: AttentionItem): { text: ReactNode; detail?: string; href: string } | null => {
    switch (item.kind) {
      case 'longAbsence':
        return {
          text: t('attLongAbsence', {
            count: f(item.students.length),
            days: f(LONG_ABSENCE_DAYS),
          }),
          href: '/attendance/today',
        };
      case 'heldSms':
        return { text: t('attHeldSms', { count: f(item.count) }), href: '#held-sms' };
      case 'notTaken':
        return {
          text: t('attNotTaken', { count: f(item.sectionIds.length), section }),
          detail: item.sectionIds.slice(0, 3).map(sectionName).join(', '),
          href: '/attendance/today',
        };
      case 'belowTarget':
        return {
          text: t('attBelowTarget', {
            count: f(item.sections.length),
            section,
            target: f(target),
          }),
          detail: item.sections
            .slice(0, 3)
            .map((s) => `${sectionName(s.sectionId)} ${f(Math.round(s.percent))}%`)
            .join(', '),
          href: '/attendance/register',
        };
      case 'setup':
        return setupStep
          ? { text: t('attSetup', { step: setupStep.title }), href: setupStep.href }
          : null;
    }
  };
  const rows = items.flatMap((item) => {
    const r = row(item);
    return r ? [{ item, ...r }] : [];
  });
  return (
    <Panel testId="attention" title={t('attentionTitle')}>
      {rows.length === 0 ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <BellRingIcon aria-hidden className="size-4" />
          {t('attentionNone')}
        </p>
      ) : (
        <ul className="-my-1 flex flex-col">
          {rows.map(({ item, text, detail, href }) => {
            const Icon = ATTENTION_ICON[item.kind];
            const tone =
              item.severity >= 3
                ? 'bg-destructive-soft text-destructive'
                : item.severity === 2
                  ? 'bg-warning-soft text-warning'
                  : 'bg-primary-soft text-primary-ink';
            return (
              <li key={item.kind}>
                <Link
                  href={href}
                  data-testid={`attention-${item.kind}`}
                  className="hover:bg-muted/60 focus-visible:ring-ring -mx-2 flex min-h-(--control-h) items-center gap-3 rounded-xl px-2 py-2 outline-none focus-visible:ring-2"
                >
                  <span
                    className={cn(
                      'flex size-9 shrink-0 items-center justify-center rounded-xl',
                      tone,
                    )}
                  >
                    <Icon aria-hidden className="size-4.5" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-medium">{text}</span>
                    {detail && (
                      <span className="text-muted-foreground truncate text-xs">{detail}</span>
                    )}
                  </span>
                  <ChevronRightIcon
                    aria-hidden
                    className="text-muted-foreground size-4 shrink-0 rtl:rotate-180"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

// ───────────────────────────── Students by class ─────────────────────────────

export function StudentsByClass({ summary }: { summary: StudentsSummary }) {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const f = (n: number) => formatCount(n, locale);
  const student = label('student', 'Student', { inText: true });
  const classLevel = label('class_level', 'Class', { inText: true });
  const items = summary.byClass
    .filter((c) => c.count > 0)
    .map((c) => ({
      key: c.classLevel.id,
      label: displayName(c.classLevel.nameBn, c.classLevel.nameEn, locale),
      value: c.count,
      display: t('byClassCount', { count: f(c.count) }),
    }));
  const total = items.reduce((sum, i) => sum + i.value, 0);
  const title = t('byClassTitle', { student, classLevel });
  return (
    <Panel testId="students-by-class" title={title}>
      {total === 0 ? (
        <p className="text-muted-foreground text-sm">{t('byClassNone', { student })}</p>
      ) : items.length > 5 ? (
        // Many classes: a bar each (in class order), never a fold into "other".
        <BarList
          title={title}
          max={Math.max(...items.map((i) => i.value))}
          items={items.map((i) => ({ ...i, value: i.value }))}
        />
      ) : (
        <Donut
          items={items}
          title={title}
          total={{ display: f(total), label: t('byClassTotal') }}
          formatShare={(share) => `${f(Math.round(share * 100))}%`}
          formatOther={(n) => t('byClassCount', { count: f(n) })}
        />
      )}
    </Panel>
  );
}

// ───────────────────────────── The term timeline ─────────────────────────────

/**
 * Where the academic year stands: start to end, today, how far through, and the exams an
 * institute of this type usually holds (hollow, "usually in June": the exams module will place
 * the real ones).
 */
export function TermTimeline({ context }: { context: MeContext }) {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const f = (n: number) => formatCount(n, locale);
  const year = context.academicYear;
  const yearLabel = label('academic_year', 'Academic Year');
  if (!year) {
    return (
      <Panel testId="term-timeline" title={yearLabel}>
        <p className="text-muted-foreground text-sm">{t('yearNone', { label: yearLabel })}</p>
      </Panel>
    );
  }
  const progress = yearProgress(year.startDate, year.endDate, context.today);
  const marks = typicalExamMarks(context.tenant.instituteType.key, year.startDate, year.endDate);
  const month = (date: string) =>
    new Intl.DateTimeFormat(locale === 'bn' ? 'bn-BD' : 'en-GB', {
      month: 'long',
      timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00Z`));
  return (
    <Panel
      testId="term-timeline"
      title={`${yearLabel} ${locale === 'bn' ? toBanglaDigits(year.name) : year.name}`}
      aside={
        <span className="text-muted-foreground text-sm">
          {t('yearDaysLeft', { count: f(progress.daysLeft), n: progress.daysLeft })}
        </span>
      }
    >
      <p className="font-numeric flex flex-wrap items-baseline gap-x-2">
        <span className="text-3xl leading-none font-light">{f(Math.round(progress.percent))}%</span>
        <span className="text-muted-foreground text-sm">
          {t('yearWeek', { week: f(progress.week), weeks: f(progress.weeks) })}
        </span>
      </p>
      <div className="relative mt-2 mb-1 h-2.5">
        <div
          role="progressbar"
          aria-label={t('yearProgressLabel', { label: yearLabel })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress.percent)}
          aria-valuetext={t('yearProgressText', {
            percent: f(Math.round(progress.percent)),
            week: f(progress.week),
            weeks: f(progress.weeks),
          })}
          className="bg-muted absolute inset-0 overflow-hidden rounded-full"
        >
          <div
            className="bg-primary h-full rounded-full"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
        {/* Today: a ring on the track, the word under it. */}
        <span
          aria-hidden
          className="bg-card border-primary absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px]"
          style={{ left: `${progress.percent}%` }}
        />
        {/* The usual exams: hollow markers on the track (named in the list under it). */}
        {marks.map((m) => (
          <span
            key={m.key}
            aria-hidden
            className="bg-card border-input absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed"
            style={{ left: `${m.percent}%` }}
          />
        ))}
      </div>
      <div className="text-muted-foreground flex justify-between text-xs">
        <span>{formatDate(year.startDate, locale, 'medium')}</span>
        <span>{formatDate(year.endDate, locale, 'medium')}</span>
      </div>
      {marks.length > 0 && (
        // A wrapping list, so long names never run into each other on a phone.
        <ul className="flex flex-wrap gap-x-5 gap-y-1.5 border-t pt-3 text-sm">
          {marks.map((m) => (
            <li key={m.key} className="flex items-center gap-2">
              <span
                aria-hidden
                className="border-input size-3 shrink-0 rounded-full border-2 border-dashed"
              />
              <span className="font-medium">{t(`exam_${m.key}`)}</span>
              <span className="text-muted-foreground">
                {t('examUsually', { month: month(m.date) })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ───────────────────────────── The hero ─────────────────────────────

/**
 * The top of the principal's day: the date in both calendars, the greeting by name, today in one
 * line, the main jobs, and this week's present % against last week's. On the theme's hero (a
 * gradient in the accent, or English medium's soft tint); the madrasa's pattern shows through.
 */
export function DashboardHero({
  date,
  greeting,
  insight,
  week,
  actions,
}: {
  date: ReactNode;
  greeting: string;
  insight: string;
  /** This week's present % and its change against last week, in points (null: not known). */
  week: { percent: number | null; change: number | null; loading?: boolean };
  actions: ReactNode;
}) {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const f = (n: number) => formatCount(n, locale);
  return (
    <section
      aria-labelledby="dashboard-greeting"
      data-testid="dashboard-hero"
      className="from-hero-from to-hero-to text-hero-foreground rounded-card shadow-card girih grid items-end gap-x-8 gap-y-5 bg-linear-to-br p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_auto]"
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div className="text-hero-muted flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          {date}
        </div>
        <h2 id="dashboard-greeting" className="font-heading text-2xl sm:text-3xl">
          {greeting}
        </h2>
        <p className="text-hero-muted max-w-prose text-base" data-testid="dashboard-insight">
          {insight}
        </p>
        <div className="mt-1">{actions}</div>
      </div>
      {week.loading && (
        <div aria-hidden className="flex flex-col gap-2 lg:items-end">
          <span className="bg-hero-foreground/15 h-4 w-28 rounded-full" />
          <span className="bg-hero-foreground/15 h-12 w-24 rounded-xl" />
        </div>
      )}
      {!week.loading && week.percent !== null && (
        <div className="flex flex-col gap-1.5 lg:items-end lg:text-end" data-testid="hero-week">
          <span className="text-hero-muted text-sm">{t('heroWeek')}</span>
          <span className="font-numeric text-5xl leading-none font-light">
            {f(Math.round(week.percent))}%
          </span>
          {week.change !== null && (
            <span className="flex flex-wrap items-center gap-2 lg:justify-end">
              <DeltaPill
                change={week.change}
                display={`${formatCount(Math.abs(week.change), locale)}%`}
                better="up"
                label={t('weekChangeLabel', {
                  change: formatCount(Math.abs(week.change), locale),
                  more: week.change > 0 ? 'true' : 'false',
                })}
              />
              <span className="text-hero-muted text-xs">{t('vsLastWeek')}</span>
            </span>
          )}
        </div>
      )}
    </section>
  );
}

'use client';

import { useQuery } from '@tanstack/react-query';
import {
  dayPeriod,
  dhakaHour,
  formatBanglaCalendarDate,
  formatCount,
  formatDate,
  formatIdentifier,
  type AttendanceTodaySummary,
  type GuardianChild,
  type MeContext,
  type StudentFilters,
  type StudentsPage,
} from '@jantrik/shared';
import {
  BookOpenCheckIcon,
  CalendarCheckIcon,
  CalendarDaysIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  CloudOffIcon,
  HeartHandshakeIcon,
  UserPlusIcon,
  UsersIcon,
  WalletIcon,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { PersonAvatar } from '@/components/person-avatar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { listDrafts } from '@/lib/attendance/drafts';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel, useMeContext } from '@/lib/hooks';
import { classLevelName, displayName, displayUserName } from '@/lib/names';
import { canSee, isStaff, navItem } from '@/lib/navigation';
import { cn } from '@/lib/utils';

export default function DashboardPage() {
  const { data: context } = useMeContext();
  if (!context) return null;
  if (isStaff(context.roles)) return <StaffDashboard context={context} />;
  if (context.roles.includes('GUARDIAN')) return <GuardianDashboard context={context} />;
  return <Greeting subtitle={null} />;
}

const GREETING = {
  morning: 'greetingMorning',
  afternoon: 'greetingAfternoon',
  evening: 'greetingEvening',
  night: 'greetingNight',
} as const;

/** Greeting by time of day in Dhaka, with today's date in both calendars. */
function Greeting({ subtitle }: { subtitle: ReactNode }) {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const { session } = useAuth();
  const now = new Date();
  const key = GREETING[dayPeriod(dhakaHour(now))];
  return (
    <div className="flex flex-col gap-3">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <span className="flex items-center gap-1.5">
          <CalendarDaysIcon aria-hidden className="size-4" />
          {formatDate(now, locale, 'full')}
        </span>
        <span
          className="bg-accent-warm-soft text-foreground inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium"
          title={t('banglaDate')}
        >
          <span aria-hidden className="bg-accent-warm size-1.5 rounded-full" />
          {formatBanglaCalendarDate(now, locale)}
          <span className="sr-only"> ({t('banglaDate')})</span>
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold sm:text-3xl">
          {t(key, { name: displayUserName(session?.user, locale) })}
        </h2>
        {subtitle && <p className="text-muted-foreground max-w-prose">{subtitle}</p>}
      </div>
    </div>
  );
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-lg font-semibold">{children}</h2>
      {aside}
    </div>
  );
}

// ───────────────────────────── Staff ─────────────────────────────

function StaffDashboard({ context }: { context: MeContext }) {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  const canSeeStudents = canSee(navItem('students'), context);
  const isAdmin = context.roles.some((r) => r === 'OWNER' || r === 'ADMIN');

  const students = useQuery({
    queryKey: ['students-total', tenantId],
    queryFn: () => client.api<StudentsPage>('/students?limit=1'),
    enabled: canSeeStudents,
  });
  const filters = useQuery({
    queryKey: ['student-filters', tenantId],
    queryFn: () => client.api<StudentFilters>('/students/filters'),
    enabled: canSeeStudents && isAdmin,
  });

  const canSeeAttendance = canSee(navItem('attendance'), context);
  const summary = useQuery({
    queryKey: ['attendance-summary', tenantId],
    queryFn: () => client.api<AttendanceTodaySummary>('/attendance/summary/today'),
    enabled: canSeeAttendance,
  });
  // Attendance kept on this phone that the server doesn't have yet.
  const [unsent] = useState(() =>
    session?.tenant ? listDrafts(session.user.id, session.tenant.id).length : 0,
  );

  const studentLabel = label('student', 'Student', { inText: true });
  const classLabel = label('class_level', 'Class', { inText: true });
  const sectionLabel = label('section', 'Section', { inText: true });
  const total = students.data?.total ?? null;
  const today = summary.data;
  const present = today ? today.counts.present + today.counts.late : 0;

  return (
    <>
      <Greeting subtitle={t('subtitle', { institute: context.tenant.name })} />

      {unsent > 0 && (
        <div
          className="border-warning/40 bg-warning-soft flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3"
          data-testid="unsent-banner"
        >
          <span className="flex items-center gap-2 font-medium">
            <CloudOffIcon aria-hidden className="text-warning size-5" />
            {t('unsentBanner', { count: formatCount(unsent, locale) })}
          </span>
          <Button
            size="sm"
            variant="outline"
            render={<Link href="/attendance" />}
            nativeButton={false}
          >
            {t('unsentOpen')}
          </Button>
        </div>
      )}

      <ul className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {canSeeStudents && (
          <StatCard
            icon={UsersIcon}
            label={t('totalStudents', { student: studentLabel })}
            hint={t('totalStudentsHint', { classLevel: classLabel })}
            value={total}
            loading={students.isPending}
            href="/students"
          />
        )}
        {canSeeAttendance && (
          <StatCard
            testId="module-card-attendance"
            icon={CalendarCheckIcon}
            label={t('presentToday')}
            href="/attendance"
            loading={summary.isPending}
            value={today ? (today.students > 0 ? present : null) : undefined}
            display={
              today && today.students > 0 ? (
                <>
                  {formatCount(present, locale)}
                  <span className="text-muted-foreground text-xl font-medium">
                    {' / '}
                    {formatCount(today.students, locale)}
                  </span>
                </>
              ) : undefined
            }
            hint={
              !today ? (
                t('presentTodayHint')
              ) : today.students === 0 ? (
                t('presentTodayNone')
              ) : (
                <>
                  {today.percent !== null && (
                    <span className="text-foreground block font-medium">
                      {t('presentTodayPercent', {
                        percent: formatCount(Math.round(today.percent), locale),
                      })}
                    </span>
                  )}
                  {t('presentTodaySectionsOf', {
                    taken: formatCount(today.sectionsTaken, locale),
                    total: formatCount(today.sectionsTotal, locale),
                    section: sectionLabel,
                  })}
                </>
              )
            }
          />
        )}
        {canSee(navItem('fees'), context) && (
          <StatCard
            testId="module-card-fees"
            icon={WalletIcon}
            label={t('feesThisMonth')}
            hint={t('feesThisMonthHint')}
          />
        )}
        {canSee(navItem('exams'), context) && (
          <StatCard
            testId="module-card-exams"
            icon={BookOpenCheckIcon}
            label={t('upcomingExam')}
            hint={t('upcomingExamHint')}
          />
        )}
      </ul>

      <div
        className={cn(
          'grid items-start gap-6',
          isAdmin && 'lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]',
        )}
      >
        {isAdmin && (
          <GettingStarted
            context={context}
            hasSections={Boolean(filters.data?.classLevels.some((c) => c.sections.length > 0))}
            hasStudents={(total ?? 0) > 0}
            hasAttendance={summary.data?.everTaken ?? false}
            loading={students.isPending || filters.isPending}
          />
        )}
        <QuickActions context={context} wide={!isAdmin} />
      </div>
    </>
  );
}

/**
 * Real numbers sit on a solid card; modules that are not running yet use a dashed outline and
 * say what will appear, instead of showing a made-up number.
 */
function StatCard({
  icon: Icon,
  label,
  hint,
  value,
  display,
  loading,
  href,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  hint: ReactNode;
  value?: number | null;
  /** Custom rendering of the value (e.g. "4 / 5"). */
  display?: ReactNode;
  loading?: boolean;
  href?: string;
  testId?: string;
}) {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const placeholder = value === undefined && display === undefined;
  const body = (
    <>
      <span className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-sm font-medium">{label}</span>
        <span
          className={cn(
            'hidden size-9 shrink-0 items-center justify-center rounded-lg sm:flex',
            placeholder ? 'bg-muted text-muted-foreground' : 'bg-primary-soft text-primary',
          )}
        >
          <Icon aria-hidden className="size-4.5" />
        </span>
      </span>
      {loading ? (
        <Skeleton className="h-10 w-20" />
      ) : (
        <span
          className={cn(
            'font-numeric text-3xl leading-none font-semibold',
            placeholder && 'text-muted-foreground',
          )}
        >
          {display ??
            (placeholder || value === null ? (
              <>
                <span aria-hidden>—</span>
                <span className="sr-only">{t('notYet')}</span>
              </>
            ) : (
              formatCount(value ?? 0, locale)
            ))}
        </span>
      )}
      <span className="text-muted-foreground text-xs leading-snug sm:text-sm">{hint}</span>
    </>
  );
  const className = cn(
    'flex h-full flex-col gap-2 rounded-xl p-3.5 sm:gap-3 sm:p-5',
    placeholder ? 'border border-dashed border-input' : 'bg-card border shadow-xs',
  );
  return (
    <li data-testid={testId}>
      {href ? (
        <Link
          href={href}
          className={cn(
            className,
            'hover:border-primary/40 focus-visible:ring-ring/40 transition-colors outline-none focus-visible:ring-3',
          )}
        >
          {body}
        </Link>
      ) : (
        <div className={className}>{body}</div>
      )}
    </li>
  );
}

function QuickActions({ context, wide }: { context: MeContext; wide?: boolean }) {
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const label = useLabel();
  const isAdmin = context.roles.some((r) => r === 'OWNER' || r === 'ADMIN');
  const actions: { key: string; icon: LucideIcon; title: string; text: string; href?: string }[] =
    [];
  if (isAdmin)
    actions.push({
      key: 'add-student',
      icon: UserPlusIcon,
      title: t('addStudent', { student: label('student', 'Student', { inText: true }) }),
      text: t('addStudentText'),
    });
  if (canSee(navItem('attendance'), context))
    actions.push({
      key: 'attendance',
      icon: CalendarCheckIcon,
      title: t('takeAttendance'),
      text: t('takeAttendanceText'),
      href: '/attendance',
    });
  if (canSee(navItem('fees'), context))
    actions.push({
      key: 'fees',
      icon: WalletIcon,
      title: t('collectFee'),
      text: t('collectFeeText'),
      href: '/fees',
    });
  if (actions.length === 0) return null;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="quick-actions">
      <SectionTitle>
        <span id="quick-actions">{t('quickActions')}</span>
      </SectionTitle>
      <ul className={cn('grid gap-3', wide && 'md:grid-cols-3')}>
        {actions.map((a) => {
          const inner = (
            <>
              <span className="bg-primary-soft text-primary flex size-11 shrink-0 items-center justify-center rounded-lg">
                <a.icon aria-hidden className="size-5" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{a.title}</span>
                <span className="text-muted-foreground text-sm">{a.text}</span>
              </span>
              {a.href ? (
                <ChevronRightIcon aria-hidden className="text-muted-foreground size-5 shrink-0" />
              ) : (
                <Badge variant="secondary">{tCommon('comingSoon')}</Badge>
              )}
            </>
          );
          const base = 'bg-card flex min-h-[76px] items-center gap-3 rounded-xl border p-3 sm:p-4';
          return (
            <li key={a.key}>
              {a.href ? (
                <Link
                  href={a.href}
                  data-testid={`quick-${a.key}`}
                  className={cn(
                    base,
                    'hover:border-primary/40 hover:bg-primary-soft/40 focus-visible:ring-ring/40 shadow-xs transition-colors outline-none focus-visible:ring-3',
                  )}
                >
                  {inner}
                </Link>
              ) : (
                <div className={cn(base, 'bg-card/60')} aria-disabled="true">
                  {inner}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The real setup sequence for a new institute, ticked from data the institute already has. */
function GettingStarted({
  context,
  hasSections,
  hasStudents,
  hasAttendance,
  loading,
}: {
  context: MeContext;
  hasSections: boolean;
  hasStudents: boolean;
  hasAttendance: boolean;
  loading: boolean;
}) {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const student = label('student', 'Student', { inText: true });
  const classLevel = label('class_level', 'Class', { inText: true });
  const section = label('section', 'Section', { inText: true });

  const steps = [
    { key: 'institute', done: true, title: t('stepInstitute'), text: t('stepInstituteText') },
    {
      key: 'year',
      done: Boolean(context.academicYear),
      title: t('stepYear', { label: label('academic_year', 'Academic Year', { inText: true }) }),
      text: t('stepYearText'),
    },
    {
      key: 'sections',
      done: hasSections,
      title: t('stepSections', { classLevel, section }),
      text: t('stepSectionsText', { classLevel, section }),
      href: '/sections',
    },
    {
      key: 'students',
      done: hasStudents,
      title: t('stepStudents', { student }),
      text: t('stepStudentsText'),
      href: '/students',
    },
    ...(context.modules.includes('ATTENDANCE')
      ? [
          {
            key: 'attendance',
            done: hasAttendance,
            title: t('stepAttendance'),
            text: t('stepAttendanceText'),
            href: '/attendance',
          },
        ]
      : []),
  ];
  const done = steps.filter((s) => s.done).length;
  if (!loading && done === steps.length) return null;
  const nextKey = steps.find((s) => !s.done)?.key;

  return (
    <section
      className="bg-card flex flex-col gap-4 rounded-xl border p-4 shadow-xs sm:p-5"
      aria-labelledby="getting-started"
      data-testid="getting-started"
    >
      <div className="flex flex-col gap-1">
        <SectionTitle
          aside={
            <span className="text-muted-foreground shrink-0 text-sm">
              {t('checklistProgress', {
                done: formatCount(done, locale),
                total: formatCount(steps.length, locale),
              })}
            </span>
          }
        >
          <span id="getting-started">{t('checklistTitle')}</span>
        </SectionTitle>
        <p className="text-muted-foreground text-sm">{t('checklistText')}</p>
        <div
          className="bg-muted mt-2 h-2 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={done}
          aria-labelledby="getting-started"
        >
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-500"
            style={{ width: `${(done / steps.length) * 100}%` }}
          />
        </div>
      </div>
      <ol className="flex flex-col">
        {steps.map((s, i) => {
          const isNext = s.key === nextKey;
          return (
            <li
              key={s.key}
              className={cn(
                'flex gap-3 border-t py-3 first:border-t-0 first:pt-1 last:pb-0',
                isNext && 'items-start',
              )}
            >
              <span
                className={cn(
                  'font-numeric flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
                  s.done
                    ? 'bg-success-soft text-success'
                    : isNext
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground border',
                )}
              >
                {s.done ? <CheckIcon aria-hidden className="size-4" /> : formatCount(i + 1, locale)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cn('font-medium', s.done && 'text-muted-foreground')}>
                  {s.title}
                  {s.done && <span className="sr-only"> ({t('done')})</span>}
                </span>
                {!s.done && <span className="text-muted-foreground text-sm">{s.text}</span>}
              </span>
              {!s.done && s.href && isNext && (
                <Button
                  size="sm"
                  variant="outline"
                  render={<Link href={s.href} />}
                  nativeButton={false}
                  className="shrink-0"
                >
                  {t('open')}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ───────────────────────────── Guardian ─────────────────────────────

function GuardianDashboard({ context }: { context: MeContext }) {
  const t = useTranslations('guardian');
  const tCommon = useTranslations('common');
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const children = useQuery({
    queryKey: ['my-children', session?.tenant?.id],
    queryFn: () => client.api<GuardianChild[]>('/me/children'),
  });

  return (
    <>
      <Greeting subtitle={t('subtitle', { institute: context.tenant.name })} />
      <section className="flex flex-col gap-3" aria-labelledby="my-children">
        <SectionTitle>
          <span id="my-children">{t('childrenTitle')}</span>
        </SectionTitle>
        {children.isPending ? (
          <div
            className="grid gap-4 md:grid-cols-2"
            aria-busy="true"
            aria-label={tCommon('loading')}
          >
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
          </div>
        ) : children.isError ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              {describe(children.error)}
              <Button size="sm" variant="outline" onClick={() => void children.refetch()}>
                {tCommon('retry')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : children.data.length === 0 ? (
          <div
            className="bg-card flex flex-col items-center gap-3 rounded-xl border px-6 py-12 text-center"
            data-testid="children-empty"
          >
            <span className="bg-primary-soft text-primary flex size-14 items-center justify-center rounded-2xl">
              <HeartHandshakeIcon aria-hidden className="size-7" />
            </span>
            <p className="font-medium">{t('none')}</p>
            <p className="text-muted-foreground max-w-md text-sm">{t('noneHint')}</p>
          </div>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2" data-testid="children">
            {children.data.map((c) => (
              <ChildCard key={c.id} child={c} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ChildCard({ child }: { child: GuardianChild }) {
  const t = useTranslations('guardian');
  const tStudents = useTranslations('students');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const name = displayName(child.nameBn, child.nameEn, locale);
  const e = child.enrolment;
  const facts = [
    {
      term: label('class_level', 'Class'),
      value: e ? classLevelName(e, locale) : tStudents('notEnrolled'),
    },
    { term: label('section', 'Section'), value: e?.section?.name ?? '—' },
    { term: t('roll'), value: e?.roll != null ? formatIdentifier(e.roll) : '—', id: true },
  ];
  return (
    <li className="bg-card flex flex-col overflow-hidden rounded-xl border shadow-xs">
      <div className="flex items-center gap-4 p-4 sm:p-5">
        <PersonAvatar name={name} photoUrl={child.photoUrl} size="xl" />
        <div className="flex min-w-0 flex-col">
          <h3 className="truncate text-xl font-semibold">{name}</h3>
          <span className="text-muted-foreground text-sm">
            {t('studentId')}{' '}
            <span className="text-foreground tabular-nums" dir="ltr">
              {formatIdentifier(child.studentCode)}
            </span>
          </span>
        </div>
      </div>
      <dl className="grid grid-cols-3 border-t">
        {facts.map((f) => (
          <div
            key={f.term}
            className="flex min-w-0 flex-col gap-0.5 border-l px-4 py-3 first:border-l-0 sm:px-5"
          >
            <dt className="text-muted-foreground text-xs">{f.term}</dt>
            <dd className={cn('truncate font-medium', f.id && 'tabular-nums')}>{f.value}</dd>
          </div>
        ))}
      </dl>
      <p className="bg-canvas text-muted-foreground flex items-center gap-2 border-t px-4 py-3 text-sm sm:px-5">
        <ClockIcon aria-hidden className="size-4 shrink-0" />
        {t('comingSoon')}
      </p>
    </li>
  );
}

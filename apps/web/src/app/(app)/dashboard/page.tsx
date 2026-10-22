'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addDays,
  ATTENDANCE_TARGET,
  attentionItems,
  dashboardInsight,
  dayPeriod,
  dhakaHour,
  formatBanglaCalendarDate,
  formatCount,
  formatDate,
  formatIdentifier,
  formatTaka,
  LONG_ABSENCE_DAYS,
  periodPercent,
  pointChange,
  splitPeriods,
  type AttendanceTodayReport,
  type AttendanceTodaySummary,
  type AttendanceTrendReport,
  type FeeSummary,
  type SendHeldSmsResult,
  type SmsDailyStatus,
  type GuardianChild,
  type MeContext,
  type StudentsPage,
  type StudentsSummary,
} from '@jantrik/shared';
import {
  CalendarCheckIcon,
  CalendarDaysIcon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  ClockIcon,
  CloudOffIcon,
  HeartHandshakeIcon,
  MessageSquareTextIcon,
  MessageSquareWarningIcon,
  SmartphoneIcon,
  UserCheckIcon,
  UserPlusIcon,
  UsersIcon,
  UserXIcon,
  WalletIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ChildCalendar } from '@/components/attendance/child-calendar';
import { ChildFeesSummary } from '@/components/fees/guardian/child-fees-summary';
import { BillingNoticeBanner } from '@/components/billing-notice';
import {
  AttendanceTrend,
  TodayAbsentees,
  TodayBoard,
  type BoardPeriod,
} from '@/components/dashboard/attendance-overview';
import { KpiPlaceholder, KpiTile } from '@/components/dashboard/kpi';
import {
  AttentionCard,
  DashboardHero,
  Deferred,
  StudentsByClass,
  TermTimeline,
  useInsightText,
} from '@/components/dashboard/principal';
import { DeltaPill, Pill } from '@/components/kit/pill';
import { HalfGauge, HatchedColumns } from '@/components/story-charts';
import { InvitationsBanner } from '@/components/invitations-banner';
import { PersonAvatar } from '@/components/person-avatar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { listDrafts } from '@/lib/attendance/drafts';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel, useMeContext } from '@/lib/hooks';
import { bnGenitive, classLevelName, displayName, displayUserName } from '@/lib/names';
import { canSee, isStaff, navItem } from '@/lib/navigation';
import { useSetupChecklist, wizardHref } from '@/lib/setup-checklist';
import { cn } from '@/lib/utils';

export default function DashboardPage() {
  const { data: context } = useMeContext();
  if (!context) return null;
  return (
    <>
      <InvitationsBanner />
      {context.roles.includes('OWNER') && <BillingNoticeBanner />}
      {isStaff(context.roles) ? (
        <StaffDashboard context={context} />
      ) : context.roles.includes('GUARDIAN') ? (
        <GuardianDashboard context={context} />
      ) : (
        <Greeting subtitle={null} />
      )}
    </>
  );
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
  const isAdmin = context.roles.some((r) => r === 'OWNER' || r === 'ADMIN');
  const canSeeStudents = canSee(navItem('students'), context);
  const canSeeAttendance = canSee(navItem('attendance'), context);
  const canSeeFees = canSee(navItem('fees'), context);
  // Owners and admins get the whole picture; everyone else their figures (teachers: part 5).
  const overview = isAdmin && canSeeAttendance;
  const f = (n: number) => formatCount(n, locale);
  const pct = (n: number) => `${f(Math.round(n))}%`;

  const summary = useQuery({
    queryKey: ['students-summary', tenantId],
    queryFn: () => client.api<StudentsSummary>('/students/summary'),
    enabled: isAdmin && canSeeStudents,
  });
  const students = useQuery({
    queryKey: ['students-total', tenantId],
    queryFn: () => client.api<StudentsPage>('/students?pageSize=1'),
    enabled: !isAdmin && canSeeStudents,
  });
  const todaySummary = useQuery({
    queryKey: ['attendance-summary', tenantId],
    queryFn: () => client.api<AttendanceTodaySummary>('/attendance/summary/today'),
    enabled: canSeeAttendance && !overview,
  });
  const report = useQuery({
    queryKey: ['attendance-report-today', tenantId],
    queryFn: () => client.api<AttendanceTodayReport>('/attendance/reports/today'),
    enabled: overview,
  });
  // The last 14 days, all sections together: the hero's and the KPIs' comparisons.
  const recent = useQuery({
    queryKey: ['attendance-trend', tenantId, 14],
    queryFn: () => client.api<AttendanceTrendReport>('/attendance/reports/trend?days=14'),
    enabled: overview,
  });
  // 60 days by section (the board's week and month, the trend against the period before):
  // loaded once those come near the screen, or a period is chosen.
  const [wantHistory, setWantHistory] = useState(false);
  const loadHistory = useCallback(() => setWantHistory(true), []);
  const history = useQuery({
    queryKey: ['attendance-trend', tenantId, 60, 'bySection'],
    queryFn: () =>
      client.api<AttendanceTrendReport>('/attendance/reports/trend?days=60&bySection=1'),
    enabled: overview && wantHistory,
  });
  const sms = useQuery({
    queryKey: ['sms-today', tenantId],
    queryFn: () => client.api<SmsDailyStatus>('/attendance/sms/today'),
    enabled: overview,
  });
  // The next setup step (the attention list): owners' and admins' overview only, and after the
  // first screen's own data (five requests that would otherwise queue ahead of it on a phone).
  const checklist = useSetupChecklist(context, overview && Boolean(report.data));
  const insightText = useInsightText();
  const [classId, setClassId] = useState<string | null>(null);
  const [boardPeriod, setBoardPeriod] = useState<BoardPeriod>('today');
  const [trendPeriod, setTrendPeriod] = useState<'week' | 'month'>('month');
  // Attendance kept on this phone that the server doesn't have yet.
  const [unsent] = useState(() =>
    session?.tenant ? listDrafts(session.user.id, session.tenant.id).length : 0,
  );

  const studentLabel = label('student', 'Student', { inText: true });
  const classLabel = label('class_level', 'Class', { inText: true });
  const sectionLabel = label('section', 'Section', { inText: true });

  // Today's figures, from the report (owners, admins) or the summary (everyone else).
  const day = overview
    ? report.data && {
        counts: report.data.totals.counts,
        percent: report.data.totals.percent,
        sectionsTaken: report.data.totals.sectionsTaken,
        sectionsTotal: report.data.totals.sectionsTotal,
      }
    : todaySummary.data;
  const dayLoading = overview ? report.isPending : todaySummary.isPending;
  const counted = day
    ? day.counts.present + day.counts.absent + day.counts.late + day.counts.leave
    : 0;
  const present = day ? day.counts.present + day.counts.late : 0;
  const longAway = (report.data?.sections ?? []).flatMap((s) =>
    (s.register?.absent ?? []).filter((st) => st.streak >= LONG_ABSENCE_DAYS),
  );
  const longAbsent = longAway.length;
  const dayFailed = overview
    ? report.isError && !report.data
    : todaySummary.isError && !todaySummary.data;

  const total = isAdmin
    ? summary.data && Object.values(summary.data.byStatus).reduce((a, n) => a + n, 0)
    : students.data?.total;
  const addedNow = summary.data?.addedByMonth.at(-1)?.count ?? 0;

  const studentsTile = canSeeStudents && (
    <KpiTile
      label={t('totalStudents', { student: studentLabel })}
      icon={UsersIcon}
      count={total === undefined ? null : { to: total, format: f }}
      loading={isAdmin ? summary.isPending : students.isPending}
      failed={isAdmin ? summary.isError && !summary.data : students.isError && !students.data}
      href="/students"
      delta={
        addedNow > 0 && (
          <DeltaPill
            change={addedNow}
            display={f(addedNow)}
            better="up"
            label={t('addedChangeLabel', { count: f(addedNow) })}
          />
        )
      }
      compare={addedNow > 0 ? t('thisMonth') : undefined}
      hint={t('totalStudentsHint', { classLevel: classLabel })}
    />
  );

  if (!overview) {
    return (
      <>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <Greeting subtitle={t('subtitle', { institute: context.tenant.name })} />
          <QuickActions context={context} />
        </div>
        <UnsentBanner count={unsent} />
        {canSeeFees && <PendingFeeSubmissions />}
        <ul className="grid grid-cols-2 gap-(--gap) md:grid-cols-3" aria-label={t('figures')}>
          {studentsTile}
          {canSeeAttendance && (
            <KpiTile
              testId="module-card-attendance"
              label={t('presentToday')}
              icon={UserCheckIcon}
              href="/attendance/today"
              loading={dayLoading}
              failed={dayFailed}
              count={day && counted > 0 ? { to: present, format: f } : null}
              suffix={day && counted > 0 ? `/ ${f(counted)}` : undefined}
              hint={
                !day ? (
                  t('presentTodayHint')
                ) : counted === 0 ? (
                  t('presentTodayNone')
                ) : (
                  <>
                    {day.percent !== null && (
                      <span className="text-foreground block font-medium">
                        {t('presentTodayPercent', { percent: f(Math.round(day.percent)) })}
                      </span>
                    )}
                    {t('presentTodaySectionsOf', {
                      taken: f(day.sectionsTaken),
                      total: f(day.sectionsTotal),
                      section: sectionLabel,
                    })}
                  </>
                )
              }
            />
          )}
          {/* Money needs the room of two tiles: a lakh in Bangla digits is wide. */}
          {canSeeFees && <FeesTile className="col-span-2" />}
        </ul>
        {isAdmin && <GettingStarted context={context} />}
        <ModulesSoon context={context} />
      </>
    );
  }

  // The last 7 days against the 7 before (the hero), and today against the last 7 days' average
  // (the KPIs).
  const r = recent.data;
  const leave = r?.leaveCountsAsAbsent ?? false;
  const weeks = r ? splitPeriods(r.days, r.today, 7) : null;
  const weekNow = weeks ? periodPercent(weeks.current, leave) : null;
  const weekBefore = weeks ? periodPercent(weeks.previous, leave) : null;
  const lastWeek = r
    ? periodPercent(
        r.days.filter((d) => d.date < r.today && d.date >= addDays(r.today, -7)),
        leave,
      )
    : null;
  const todayChange =
    day?.percent !== null && day?.percent !== undefined ? pointChange(day.percent, lastWeek) : null;
  const schoolDays = (weeks?.current ?? []).filter((d) => !d.nonWorkingDay);
  // The hatched week's scale starts under its lowest day (at 80 at most), so a 93 % day and a
  // 97 % day look different and no day looks like none.
  const lowestDay = Math.min(100, ...schoolDays.map((d) => d.percent ?? 100));
  const weekFloor = Math.max(0, Math.min(80, Math.floor(lowestDay / 10) * 10 - 10));

  const offDay = report.data?.nonWorkingDay ?? null;
  const facts = report.data
    ? dashboardInsight({
        sectionsTotal: report.data.totals.sectionsTotal,
        sectionsTaken: report.data.totals.sectionsTaken,
        counts: report.data.totals.counts,
        longAbsent,
        week: { now: weekNow, before: weekBefore },
        dayOff: offDay
          ? {
              name:
                offDay.reason === 'HOLIDAY'
                  ? locale === 'bn'
                    ? offDay.nameBn
                    : offDay.nameEn
                  : null,
            }
          : null,
      })
    : null;

  const sectionNames = new Map(
    (report.data?.sections ?? []).map((s) => [
      s.section.id,
      `${displayName(s.section.classLevel.nameBn, s.section.classLevel.nameEn, locale)} ${s.section.name}`,
    ]),
  );
  const nextStep = checklist.loading ? undefined : checklist.steps.find((s) => !s.done);
  // Off only once the setting has loaded as off (not while it is on its way, nor if it failed).
  const smsOff = checklist.absentSms === false;
  // "Call their guardian": one student opens their record (the guardian, a call button and the
  // number to dial from a desk phone); more go to today's absentees.
  const callHref = longAway.length === 1 ? `/students/${longAway[0]!.id}` : '/attendance/today';
  const h = history.data;
  const attention = report.data
    ? attentionItems({
        absent: report.data.sections.flatMap((s) =>
          (s.register?.absent ?? []).map((st) => ({
            id: st.id,
            sectionId: s.section.id,
            streak: st.streak,
          })),
        ),
        notTaken: offDay
          ? []
          : report.data.sections.filter((s) => !s.register).map((s) => s.section.id),
        heldSms: sms.data?.held ?? 0,
        week: h
          ? h.sections.map((l) => ({
              sectionId: l.section.id,
              percent: periodPercent(
                splitPeriods(l.days, h.today, 7).current,
                h.leaveCountsAsAbsent,
              ),
            }))
          : [],
        // "Getting started" is on this page and says it already.
        nextSetupStep: null,
      })
    : [];

  const now = new Date();
  return (
    <>
      <DashboardHero
        date={
          <>
            <span className="flex items-center gap-1.5">
              <CalendarDaysIcon aria-hidden className="size-4" />
              {formatDate(now, locale, 'full')}
            </span>
            <span
              className="border-hero-foreground/30 inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium"
              title={t('banglaDate')}
            >
              {formatBanglaCalendarDate(now, locale)}
              <span className="sr-only"> ({t('banglaDate')})</span>
            </span>
          </>
        }
        greeting={t(GREETING[dayPeriod(dhakaHour(now))], {
          name: displayUserName(session?.user, locale),
        })}
        insight={
          facts
            ? insightText(facts, { callHref })
            : t('subtitle', { institute: context.tenant.name })
        }
        week={{
          percent: weekNow,
          change: pointChange(weekNow, weekBefore),
          loading: recent.isPending,
        }}
        actions={<QuickActions context={context} onHero />}
      />

      <UnsentBanner count={unsent} />
      <HeldSmsBanner />
      {canSeeFees && <PendingFeeSubmissions />}

      <ul
        className="grid grid-cols-2 gap-(--gap) md:grid-cols-3 xl:grid-cols-5"
        aria-label={t('figures')}
      >
        {studentsTile}
        <KpiTile
          testId="module-card-attendance"
          label={t('presentToday')}
          icon={UserCheckIcon}
          href="/attendance/today"
          loading={dayLoading}
          failed={dayFailed}
          count={day && counted > 0 ? { to: present, format: f } : null}
          suffix={day && counted > 0 ? `/ ${f(counted)}` : undefined}
          delta={
            todayChange !== null && (
              <DeltaPill
                change={todayChange}
                display={`${formatCount(Math.abs(todayChange), locale)}%`}
                better="up"
                label={t('todayChangeLabel', {
                  change: formatCount(Math.abs(todayChange), locale),
                  more: todayChange > 0 ? 'true' : 'false',
                })}
              />
            )
          }
          compare={todayChange !== null ? t('vsLastWeekAverage') : undefined}
          // The last 7 days' school days hatched, today solid, beside the figure.
          aside={
            schoolDays.length > 1 && (
              <HatchedColumns
                decorative
                min={weekFloor}
                height={40}
                title={t('presentToday')}
                highlight={r?.today}
                items={schoolDays.map((d) => ({
                  key: d.date,
                  label: d.date,
                  value: d.percent,
                  display: d.percent === null ? '' : pct(d.percent),
                }))}
                // 80 px fits beside a two-digit figure in a five-tile row at 1280.
                className="w-20 2xl:w-24"
              />
            )
          }
          hint={
            !day
              ? t('presentTodayHint')
              : counted === 0
                ? t('presentTodayNone')
                : day.percent !== null &&
                  t('presentTodayPercent', { percent: f(Math.round(day.percent)) })
          }
        />
        <KpiTile
          testId="kpi-absent"
          label={t('absentToday')}
          icon={UserXIcon}
          href="/attendance/today"
          loading={dayLoading}
          failed={dayFailed}
          count={day && counted > 0 ? { to: day.counts.absent, format: f } : null}
          hint={
            day && counted > 0 ? (
              longAbsent > 0 ? (
                <Pill tone="destructive" className="whitespace-normal">
                  {t('absentRun', { count: f(longAbsent), days: f(LONG_ABSENCE_DAYS) })}
                </Pill>
              ) : (
                t('absentRunNone', { days: f(LONG_ABSENCE_DAYS) })
              )
            ) : (
              t('presentTodayHint')
            )
          }
        />
        <KpiTile
          testId="kpi-registers"
          label={t('registersTaken')}
          icon={ClipboardCheckIcon}
          href="/attendance/today"
          loading={dayLoading}
          failed={dayFailed}
          count={day && day.sectionsTotal > 0 ? { to: day.sectionsTaken, format: f } : null}
          suffix={day && day.sectionsTotal > 0 ? `/ ${f(day.sectionsTotal)}` : undefined}
          aside={
            day &&
            day.sectionsTotal > 0 && (
              <HalfGauge
                size={72}
                value={day.sectionsTaken}
                max={day.sectionsTotal}
                display={pct((day.sectionsTaken / day.sectionsTotal) * 100)}
                label={t('registersMeter', {
                  taken: f(day.sectionsTaken),
                  total: f(day.sectionsTotal),
                  section: sectionLabel,
                  sectionOf: locale === 'bn' ? bnGenitive(sectionLabel) : sectionLabel,
                })}
              />
            )
          }
          hint={
            day && day.sectionsTotal > 0
              ? day.sectionsTaken < day.sectionsTotal
                ? t('registersLeft', {
                    count: f(day.sectionsTotal - day.sectionsTaken),
                    n: day.sectionsTotal - day.sectionsTaken,
                    section: sectionLabel,
                  })
                : t('registersDone', { section: sectionLabel })
              : t('boardEmpty', { section: sectionLabel })
          }
        />
        <KpiTile
          testId="kpi-sms"
          // The fifth tile: the whole row on a phone (two columns there).
          className="col-span-2 md:col-span-1"
          label={t('smsToday')}
          icon={MessageSquareTextIcon}
          href="/attendance/settings#settings-sms"
          loading={sms.isPending}
          failed={sms.isError && !sms.data}
          value={smsOff ? t('smsOffValue') : undefined}
          count={sms.data && !smsOff ? { to: sms.data.used, format: f } : null}
          suffix={sms.data && !smsOff ? `/ ${f(sms.data.cap)}` : undefined}
          aside={
            sms.data &&
            !smsOff &&
            sms.data.cap > 0 && (
              <HalfGauge
                size={72}
                value={sms.data.used}
                max={sms.data.cap}
                tone={sms.data.held > 0 || sms.data.used >= sms.data.cap ? 'warning' : 'accent'}
                display={pct((sms.data.used / sms.data.cap) * 100)}
                label={t('smsMeter', { used: f(sms.data.used), cap: f(sms.data.cap) })}
              />
            )
          }
          hint={
            sms.data &&
            (smsOff
              ? t('smsOff')
              : sms.data.held > 0
                ? t('smsHeld', { count: f(sms.data.held) })
                : t('smsLeft', { count: f(Math.max(0, sms.data.cap - sms.data.used)) }))
          }
        />
      </ul>

      <div className="grid items-start gap-(--gap) xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-(--gap)">
          {report.isError && !report.data ? (
            <LoadError error={report.error} onRetry={() => void report.refetch()} />
          ) : report.data ? (
            <TodayBoard
              report={report.data}
              history={history.data}
              historyFailed={history.isError && !history.data}
              onRetryHistory={() => void history.refetch()}
              period={boardPeriod}
              onPeriodChange={(p) => {
                setBoardPeriod(p);
                if (p !== 'today') loadHistory();
              }}
              classId={classId}
              onClassChange={setClassId}
            />
          ) : (
            <Skeleton className="rounded-card h-64" />
          )}
          {report.data && (
            <Deferred height={300} onVisible={loadHistory}>
              {history.isError && !history.data ? (
                <LoadError error={history.error} onRetry={() => void history.refetch()} />
              ) : history.data ? (
                <AttendanceTrend
                  report={history.data}
                  classId={classId}
                  period={trendPeriod}
                  onPeriodChange={setTrendPeriod}
                />
              ) : (
                <Skeleton className="rounded-card h-72" />
              )}
            </Deferred>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-(--gap)">
          {report.data ? (
            <AttentionCard
              items={attention}
              sectionName={(id) => sectionNames.get(id) ?? ''}
              setupStep={nextStep?.href ? { title: nextStep.title, href: nextStep.href } : null}
              target={ATTENDANCE_TARGET}
            />
          ) : (
            !report.isError && <Skeleton className="rounded-card h-40" />
          )}
          {canSeeFees && (
            <ul aria-label={t('feesFigures')}>
              <FeesTile />
            </ul>
          )}
          {report.isError && !report.data ? null : report.data ? (
            <TodayAbsentees report={report.data} classId={classId} />
          ) : (
            <Skeleton className="rounded-card h-48" />
          )}
          {/* Beside the trend, so the right column does not end halfway down the page. */}
          {canSeeStudents && (
            <Deferred height={220}>
              {summary.data ? (
                <StudentsByClass summary={summary.data} />
              ) : (
                <Skeleton className="rounded-card h-56" />
              )}
            </Deferred>
          )}
        </div>
      </div>

      <Deferred height={200}>
        <TermTimeline context={context} />
      </Deferred>

      <GettingStarted context={context} after={Boolean(report.data)} />
      <ModulesSoon context={context} />
    </>
  );
}

/** Attendance kept on this phone that the server doesn't have yet. */
function UnsentBanner({ count }: { count: number }) {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  if (count <= 0) return null;
  return (
    <div
      className="border-warning/40 bg-warning-soft rounded-card flex flex-wrap items-center justify-between gap-3 border px-4 py-3"
      data-testid="unsent-banner"
    >
      <span className="flex items-center gap-2 font-medium">
        <CloudOffIcon aria-hidden className="text-warning size-5" />
        {t('unsentBanner', { count: formatCount(count, locale) })}
      </span>
      <ButtonLink size="sm" variant="outline" href="/attendance">
        {t('unsentOpen')}
      </ButtonLink>
    </div>
  );
}

/** Modules not running yet: what will appear here, never a made-up number. */
function ModulesSoon({ context }: { context: MeContext }) {
  const t = useTranslations('dashboard');
  const exams = canSee(navItem('exams'), context);
  if (!exams) return null;
  return (
    <ul className="grid gap-(--gap) sm:grid-cols-2" aria-label={t('modulesSoon')}>
      <KpiPlaceholder
        testId="module-card-exams"
        label={t('upcomingExam')}
        hint={t('upcomingExamHint')}
      />
    </ul>
  );
}

/** The fee card's figures (OWNER/ADMIN/ACCOUNTANT): one request for the tile and the reminder. */
function useFeeSummary() {
  const { client, session } = useAuth();
  return useQuery({
    queryKey: ['fee-summary', session?.tenant?.id],
    queryFn: () => client.api<FeeSummary>('/fees/summary'),
  });
}

/**
 * Collected this month, against the same days of last month (more is better), with what is
 * overdue under it. Opens this month's collections.
 */
function FeesTile({ className }: { className?: string }) {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const summary = useFeeSummary();
  const s = summary.data;
  const taka = (paisa: number) => formatTaka(paisa, locale);
  const now = s?.month.collectedPaisa ?? 0;
  const before = s?.previousMonthToDate.collectedPaisa ?? 0;
  // A percentage needs something to compare with: none when last month had nothing by now.
  const change = s && before > 0 ? Math.round(((now - before) / before) * 100) : null;
  return (
    <KpiTile
      testId="module-card-fees"
      className={className}
      label={t('feesThisMonth')}
      icon={WalletIcon}
      href="/fees/reports?tab=collections"
      loading={summary.isPending}
      failed={summary.isError && !summary.data}
      // Counting up in whole taka; the paisa only in the final figure.
      count={s ? { to: now, format: (n) => taka(n === now ? n : Math.round(n / 100) * 100) } : null}
      delta={
        change !== null && (
          <DeltaPill
            change={change}
            display={`${formatCount(Math.abs(change), locale)}%`}
            better="up"
            label={t('feesChangeLabel', {
              change: formatCount(Math.abs(change), locale),
              more: change > 0 ? 'true' : 'false',
              amount: taka(before),
            })}
          />
        )
      }
      compare={
        s
          ? before > 0
            ? t('feesVsLastMonth', { amount: taka(before) })
            : t('feesVsLastMonthNone')
          : undefined
      }
      hint={
        s &&
        (s.overdue.paisa > 0
          ? t('feesOverdue', {
              amount: taka(s.overdue.paisa),
              count: formatCount(s.overdue.students, locale),
              n: s.overdue.students,
              student: label('student', 'Student', { inText: true }),
            })
          : t('feesOverdueNone'))
      }
    />
  );
}

/** bKash/Nagad payments waiting to be checked: the guardians are waiting for their receipts. */
function PendingFeeSubmissions() {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const summary = useFeeSummary();
  const pending = summary.data?.pendingSubmissions ?? 0;
  if (pending === 0) return null;
  return (
    <Link
      href="/fees/submissions"
      data-slot="card"
      data-testid="attention-fee-submissions"
      className="bg-card rounded-card shadow-card lift focus-visible:ring-ring flex min-h-(--control-h) items-center gap-3 border px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
    >
      <span className="bg-warning-soft text-warning flex size-9 shrink-0 items-center justify-center rounded-xl">
        <SmartphoneIcon aria-hidden className="size-4.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">
          {t('feesPendingTitle', { count: formatCount(pending, locale), n: pending })}
        </span>
        <span className="text-muted-foreground text-sm">{t('feesPendingText')}</span>
      </span>
      <span className="text-link hidden shrink-0 text-sm font-medium sm:inline">
        {t('feesPendingOpen')}
      </span>
      <ChevronRightIcon
        aria-hidden
        className="text-muted-foreground size-4 shrink-0 rtl:rotate-180"
      />
    </Link>
  );
}

/** A part of the dashboard that could not be loaded: why, and a way to try again. */
function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const tCommon = useTranslations('common');
  const describe = useErrorMessage();
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        {describe(error)}
        <Button size="sm" variant="outline" onClick={onRetry}>
          {tCommon('retry')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The day's main jobs, beside the greeting: taking attendance first. `onHero`: drawn on the
 * hero (its text colour as the fill, outlines in it), every pair tested on both gradient stops.
 */
function QuickActions({ context, onHero = false }: { context: MeContext; onHero?: boolean }) {
  const t = useTranslations('dashboard');
  const label = useLabel();
  const isAdmin = context.roles.some((r) => r === 'OWNER' || r === 'ADMIN');
  const main = onHero ? 'bg-hero-foreground text-hero-from hover:bg-hero-foreground/90' : undefined;
  const other = onHero
    ? 'border-hero-foreground/40 text-hero-foreground hover:bg-hero-foreground/10 hover:text-hero-foreground bg-transparent'
    : undefined;
  return (
    <div className="flex flex-wrap gap-2" aria-label={t('quickActions')} role="group">
      {canSee(navItem('attendance'), context) && (
        <ButtonLink href="/attendance" data-testid="quick-attendance" className={main}>
          <CalendarCheckIcon aria-hidden />
          {t('takeAttendance')}
        </ButtonLink>
      )}
      {isAdmin && canSee(navItem('students'), context) && (
        <ButtonLink
          href="/students/new"
          variant="outline"
          data-testid="quick-add-student"
          className={other}
        >
          <UserPlusIcon aria-hidden />
          {t('addStudent', { student: label('student', 'Student', { inText: true }) })}
        </ButtonLink>
      )}
      {canSee(navItem('fees'), context) && !navItem('fees').soon && (
        <ButtonLink href="/fees" variant="outline" data-testid="quick-fees" className={other}>
          <WalletIcon aria-hidden />
          {t('collectFee')}
        </ButtonLink>
      )}
    </div>
  );
}

/**
 * The real setup sequence for a new institute, ticked from data the institute already has.
 * `after`: wait for it (the overview loads its own first screen first).
 */
function GettingStarted({ context, after = true }: { context: MeContext; after?: boolean }) {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const { steps, done, wizard, loading } = useSetupChecklist(context, after);
  if (!after || (!loading && done === steps.length && !wizard)) return null;
  const nextKey = steps.find((s) => !s.done)?.key;

  return (
    <section
      className="bg-card flex flex-col gap-3 rounded-lg border p-(--panel-p)"
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
        {wizard && (
          <ButtonLink
            href={wizardHref(wizard)}
            className="mt-2 self-start"
            data-testid="continue-setup"
          >
            {t('continueSetup')}
            <ChevronRightIcon aria-hidden />
          </ButtonLink>
        )}
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
      {/* Compact: what is done is one line of ticks; only what is left gets a row. */}
      {done > 0 && (
        <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {steps
            .filter((s) => s.done)
            .map((s) => (
              <li key={s.key} className="inline-flex items-center gap-1.5">
                <CheckIcon aria-hidden className="text-success size-4 shrink-0" />
                {s.title}
                <span className="sr-only"> ({t('done')})</span>
              </li>
            ))}
        </ul>
      )}
      <ol className="flex flex-col">
        {steps.map((s, i) =>
          s.done ? null : (
            <li key={s.key} className="flex items-start gap-3 border-t py-2.5 last:pb-0">
              <span
                className={cn(
                  'font-numeric flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
                  s.key === nextKey
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground border',
                )}
              >
                {formatCount(i + 1, locale)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{s.title}</span>
                <span className="text-muted-foreground text-sm">{s.text}</span>
              </span>
              {s.href && s.key === nextKey && (
                <ButtonLink size="sm" variant="outline" href={s.href} className="shrink-0">
                  {t('open')}
                </ButtonLink>
              )}
            </li>
          ),
        )}
      </ol>
    </section>
  );
}

/**
 * SMS held back today by the daily cap: the admin can send them anyway (after confirming).
 * The API re-checks each student is still absent; anything not sent today expires at midnight.
 */
function HeldSmsBanner() {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const key = ['sms-today', session?.tenant?.id];
  const status = useQuery({
    queryKey: key,
    queryFn: () => client.api<SmsDailyStatus>('/attendance/sms/today'),
  });
  const send = useMutation({
    mutationFn: () =>
      client.api<SendHeldSmsResult>('/attendance/sms/held/send', { method: 'POST' }),
    onSuccess: (r) => {
      setOpen(false);
      const n = {
        queued: formatCount(r.queued, locale),
        cancelled: formatCount(r.cancelled, locale),
      };
      toast.success(r.cancelled > 0 ? t('heldDoneCancelled', n) : t('heldDone', n));
      if (r.stillHeld > 0 && r.platformLimit !== null) {
        toast.warning(
          t('heldPlatformLimit', {
            held: formatCount(r.stillHeld, locale),
            limit: formatCount(r.platformLimit, locale),
          }),
        );
      }
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(`${t('heldFailed')} ${describe(e)}`),
  });
  const held = status.data?.held ?? 0;
  if (held === 0) return null;
  const count = formatCount(held, locale);
  return (
    <div
      className="border-warning/40 bg-warning-soft flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
      id="held-sms"
      data-testid="held-sms"
    >
      <div className="flex min-w-0 gap-3">
        <MessageSquareWarningIcon aria-hidden className="text-warning mt-0.5 size-5 shrink-0" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{t('heldTitle', { count })}</span>
          <span className="text-muted-foreground text-sm">
            {t('heldText', { cap: formatCount(status.data!.cap, locale) })}
          </span>
        </div>
      </div>
      <Button variant="outline" className="shrink-0" onClick={() => setOpen(true)}>
        {t('heldSend')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="held-confirm">
          <DialogHeader>
            <DialogTitle>{t('heldConfirmTitle', { count, n: held })}</DialogTitle>
            <DialogDescription>{t('heldConfirmBody')}</DialogDescription>
          </DialogHeader>
          <dl className="bg-muted/50 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-lg px-3 py-2 text-sm">
            <dt className="text-muted-foreground">{t('heldConfirmMessages')}</dt>
            <dd className="font-numeric text-end font-medium" data-testid="held-confirm-count">
              {t('heldConfirmMessagesValue', { count })}
            </dd>
            <dt className="text-muted-foreground">{t('heldConfirmSegments')}</dt>
            <dd className="font-numeric text-end font-medium" data-testid="held-confirm-segments">
              {t('heldConfirmSegmentsValue', {
                segments: formatCount(status.data!.heldSegments, locale),
                n: status.data!.heldSegments,
              })}
            </dd>
          </dl>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('heldConfirmNo')}
            </Button>
            <Button onClick={() => send.mutate()} disabled={send.isPending}>
              {t('heldConfirmYes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
            <span className="bg-primary-soft text-primary-ink flex size-14 items-center justify-center rounded-2xl">
              <HeartHandshakeIcon aria-hidden className="size-7" />
            </span>
            <p className="font-medium">{t('none')}</p>
            <p className="text-muted-foreground max-w-md text-sm">{t('noneHint')}</p>
          </div>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2" data-testid="children">
            {children.data.map((c) => (
              <ChildCard
                key={c.id}
                child={c}
                showAttendance={context.modules.includes('ATTENDANCE')}
                showFees={context.modules.includes('FEES')}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ChildCard({
  child,
  showAttendance,
  showFees,
}: {
  child: GuardianChild;
  showAttendance: boolean;
  showFees: boolean;
}) {
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
    <li
      data-slot="card"
      className="bg-card rounded-card shadow-card flex flex-col overflow-hidden border"
    >
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
      {showFees && <ChildFeesSummary childId={child.id} />}
      {showAttendance && <ChildCalendar studentId={child.id} />}
      <p className="bg-canvas text-muted-foreground flex items-center gap-2 border-t px-4 py-3 text-sm sm:px-5">
        <ClockIcon aria-hidden className="size-4 shrink-0" />
        {showFees ? t('examsSoon') : t('comingSoon')}
      </p>
    </li>
  );
}

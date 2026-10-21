'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  dayPeriod,
  dhakaHour,
  formatBanglaCalendarDate,
  formatCount,
  formatDate,
  formatIdentifier,
  type AttendanceTodayReport,
  type AttendanceTodaySummary,
  type AttendanceTrendReport,
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
  ClockIcon,
  CloudOffIcon,
  HeartHandshakeIcon,
  MessageSquareWarningIcon,
  UserPlusIcon,
  WalletIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ChildCalendar } from '@/components/attendance/child-calendar';
import { BillingNoticeBanner } from '@/components/billing-notice';
import { Meter, Sparkline } from '@/components/charts';
import {
  AttendanceTrend,
  LONG_ABSENCE,
  TodayAbsentees,
  TodayBoard,
} from '@/components/dashboard/attendance-overview';
import { KpiPlaceholder, KpiTile } from '@/components/dashboard/kpi';
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
import { classLevelName, displayName, displayUserName } from '@/lib/names';
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
  // Owners and admins get the whole picture; everyone else their figures (teachers: part 5).
  const overview = isAdmin && canSeeAttendance;
  const f = (n: number) => formatCount(n, locale);

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
  const trend = useQuery({
    queryKey: ['attendance-trend', tenantId, 30],
    queryFn: () =>
      client.api<AttendanceTrendReport>('/attendance/reports/trend?days=30&bySection=1'),
    enabled: overview,
  });
  const sms = useQuery({
    queryKey: ['sms-today', tenantId],
    queryFn: () => client.api<SmsDailyStatus>('/attendance/sms/today'),
    enabled: overview,
  });
  const [classId, setClassId] = useState<string | null>(null);
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
  const longAbsent = (report.data?.sections ?? [])
    .flatMap((s) => s.register?.absent ?? [])
    .filter((st) => st.streak >= LONG_ABSENCE).length;

  // The KPI's comparison (docs/design.md → Principles 9): the school day before today.
  const before = trend.data?.days.slice(0, -1).findLast((d) => d.percent !== null) ?? null;
  const dayFailed = overview
    ? report.isError && !report.data
    : todaySummary.isError && !todaySummary.data;

  const total = isAdmin
    ? summary.data && Object.values(summary.data.byStatus).reduce((a, n) => a + n, 0)
    : students.data?.total;
  const addedNow = summary.data?.addedByMonth.at(-1)?.count ?? 0;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <Greeting subtitle={t('subtitle', { institute: context.tenant.name })} />
        <QuickActions context={context} />
      </div>

      {unsent > 0 && (
        <div
          className="border-warning/40 bg-warning-soft flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3"
          data-testid="unsent-banner"
        >
          <span className="flex items-center gap-2 font-medium">
            <CloudOffIcon aria-hidden className="text-warning size-5" />
            {t('unsentBanner', { count: f(unsent) })}
          </span>
          <ButtonLink size="sm" variant="outline" href="/attendance">
            {t('unsentOpen')}
          </ButtonLink>
        </div>
      )}

      {overview && <HeldSmsBanner />}

      <ul
        className={cn(
          'grid grid-cols-2 gap-(--gap)',
          overview ? 'md:grid-cols-3 xl:grid-cols-5' : 'md:grid-cols-3',
        )}
        aria-label={t('figures')}
      >
        {canSeeStudents && (
          <KpiTile
            label={t('totalStudents', { student: studentLabel })}
            value={total === undefined ? null : f(total)}
            loading={isAdmin ? summary.isPending : students.isPending}
            failed={isAdmin ? summary.isError && !summary.data : students.isError && !students.data}
            href="/students"
            chart={
              summary.data && (
                <Sparkline
                  values={summary.data.addedByMonth.map((m) => m.count)}
                  tone="sky"
                  className="h-6 w-full max-w-24"
                />
              )
            }
            hint={
              <>
                {t('totalStudentsHint', { classLevel: classLabel })}
                {summary.data && addedNow > 0 && (
                  <span className="block">{t('addedThisMonth', { count: f(addedNow) })}</span>
                )}
              </>
            }
          />
        )}
        {canSeeAttendance && (
          <KpiTile
            testId="module-card-attendance"
            label={t('presentToday')}
            href="/attendance/today"
            loading={dayLoading}
            failed={dayFailed}
            value={
              day && counted > 0 ? (
                <>
                  {f(present)}
                  <span className="text-muted-foreground text-xl font-medium">
                    {' / '}
                    {f(counted)}
                  </span>
                </>
              ) : null
            }
            chart={
              trend.data && (
                <Sparkline
                  values={trend.data.days.map((d) => d.percent)}
                  className="h-6 w-full max-w-24"
                />
              )
            }
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
                  {before && (
                    <span className="block">
                      {t('prevDay', { percent: f(Math.round(before.percent!)) })}
                    </span>
                  )}
                  {!overview &&
                    t('presentTodaySectionsOf', {
                      taken: f(day.sectionsTaken),
                      total: f(day.sectionsTotal),
                      section: sectionLabel,
                    })}
                </>
              )
            }
          />
        )}
        {overview && (
          <KpiTile
            testId="kpi-absent"
            label={t('absentToday')}
            href="/attendance/today"
            loading={dayLoading}
            failed={dayFailed}
            value={day && counted > 0 ? f(day.counts.absent) : null}
            hint={
              day && counted > 0
                ? longAbsent > 0
                  ? t('absentRun', { count: f(longAbsent), days: f(LONG_ABSENCE) })
                  : t('absentRunNone', { days: f(LONG_ABSENCE) })
                : t('presentTodayHint')
            }
          />
        )}
        {overview && (
          <KpiTile
            testId="kpi-registers"
            label={t('registersTaken')}
            href="/attendance/today"
            loading={dayLoading}
            failed={dayFailed}
            value={
              day && day.sectionsTotal > 0 ? (
                <>
                  {f(day.sectionsTaken)}
                  <span className="text-muted-foreground text-xl font-medium">
                    {' / '}
                    {f(day.sectionsTotal)}
                  </span>
                </>
              ) : null
            }
            meter={
              day &&
              day.sectionsTotal > 0 && (
                <Meter
                  value={day.sectionsTaken}
                  max={day.sectionsTotal}
                  label={t('registersMeter', {
                    taken: f(day.sectionsTaken),
                    total: f(day.sectionsTotal),
                    section: sectionLabel,
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
        )}
        {overview && (
          <KpiTile
            testId="kpi-sms"
            // The fifth tile: the whole row on a phone (two columns there).
            className="col-span-2 md:col-span-1"
            label={t('smsToday')}
            href="/attendance/settings#settings-sms"
            loading={sms.isPending}
            failed={sms.isError && !sms.data}
            value={
              sms.data ? (
                <>
                  {f(sms.data.used)}
                  <span className="text-muted-foreground text-xl font-medium">
                    {' / '}
                    {f(sms.data.cap)}
                  </span>
                </>
              ) : null
            }
            meter={
              sms.data && (
                <Meter
                  value={sms.data.used}
                  max={sms.data.cap}
                  tone={sms.data.held > 0 || sms.data.used >= sms.data.cap ? 'warning' : 'board'}
                  label={t('smsMeter', { used: f(sms.data.used), cap: f(sms.data.cap) })}
                />
              )
            }
            hint={
              sms.data &&
              (sms.data.held > 0
                ? t('smsHeld', { count: f(sms.data.held) })
                : t('smsLeft', { count: f(Math.max(0, sms.data.cap - sms.data.used)) }))
            }
          />
        )}
      </ul>

      {overview && (
        <div className="grid items-start gap-(--gap) xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-(--gap)">
            {report.isError && !report.data ? (
              <LoadError error={report.error} onRetry={() => void report.refetch()} />
            ) : report.data ? (
              <TodayBoard report={report.data} classId={classId} onClassChange={setClassId} />
            ) : (
              <Skeleton className="h-64 rounded-lg" />
            )}
            <GettingStarted context={context} />
          </div>
          <div className="flex min-w-0 flex-col gap-(--gap)">
            {report.isError && !report.data ? null : report.data ? (
              <TodayAbsentees report={report.data} classId={classId} />
            ) : (
              <Skeleton className="h-48 rounded-lg" />
            )}
            {trend.isError && !trend.data ? (
              <LoadError error={trend.error} onRetry={() => void trend.refetch()} />
            ) : trend.data ? (
              <AttendanceTrend report={trend.data} classId={classId} />
            ) : (
              <Skeleton className="h-56 rounded-lg" />
            )}
          </div>
        </div>
      )}
      {!overview && isAdmin && <GettingStarted context={context} />}

      {(canSee(navItem('fees'), context) || canSee(navItem('exams'), context)) && (
        <ul className="grid gap-(--gap) sm:grid-cols-2" aria-label={t('modulesSoon')}>
          {canSee(navItem('fees'), context) && (
            <KpiPlaceholder
              testId="module-card-fees"
              label={t('feesThisMonth')}
              hint={t('feesThisMonthHint')}
            />
          )}
          {canSee(navItem('exams'), context) && (
            <KpiPlaceholder
              testId="module-card-exams"
              label={t('upcomingExam')}
              hint={t('upcomingExamHint')}
            />
          )}
        </ul>
      )}
    </>
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

/** The day's main jobs, beside the greeting: taking attendance first. */
function QuickActions({ context }: { context: MeContext }) {
  const t = useTranslations('dashboard');
  const label = useLabel();
  const isAdmin = context.roles.some((r) => r === 'OWNER' || r === 'ADMIN');
  return (
    <div className="flex flex-wrap gap-2" aria-label={t('quickActions')} role="group">
      {canSee(navItem('attendance'), context) && (
        <ButtonLink href="/attendance" data-testid="quick-attendance">
          <CalendarCheckIcon aria-hidden />
          {t('takeAttendance')}
        </ButtonLink>
      )}
      {isAdmin && canSee(navItem('students'), context) && (
        <ButtonLink href="/students/new" variant="outline" data-testid="quick-add-student">
          <UserPlusIcon aria-hidden />
          {t('addStudent', { student: label('student', 'Student', { inText: true }) })}
        </ButtonLink>
      )}
      {canSee(navItem('fees'), context) && (
        <ButtonLink href="/fees" variant="outline" data-testid="quick-fees">
          <WalletIcon aria-hidden />
          {t('collectFee')}
        </ButtonLink>
      )}
    </div>
  );
}

/** The real setup sequence for a new institute, ticked from data the institute already has. */
function GettingStarted({ context }: { context: MeContext }) {
  const t = useTranslations('dashboard');
  const locale = useLocale() as Locale;
  const { steps, done, wizard, loading } = useSetupChecklist(context);
  if (!loading && done === steps.length && !wizard) return null;
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
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ChildCard({ child, showAttendance }: { child: GuardianChild; showAttendance: boolean }) {
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
      {showAttendance && <ChildCalendar studentId={child.id} />}
      <p className="bg-canvas text-muted-foreground flex items-center gap-2 border-t px-4 py-3 text-sm sm:px-5">
        <ClockIcon aria-hidden className="size-4 shrink-0" />
        {t('comingSoon')}
      </p>
    </li>
  );
}

'use client';

import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  dateToDb,
  formatCount,
  formatDate,
  formatWallClock,
  type AttendanceMode,
  type AttendanceSettings,
  type MeContext,
  type Onboarding,
  type OnboardingStep,
  type OnboardingStepState,
  type SetupAcademicYear,
  type SetupClassLevel,
  type SetupSection,
  type SetupShift,
  type StaffMember,
  type StudentsPage,
} from '@jantrik/shared';
import {
  CheckIcon,
  FileSpreadsheetIcon,
  MinusIcon,
  PartyPopperIcon,
  PencilIcon,
  PlusIcon,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ChoiceChip, ToggleField } from '@/components/form-kit';
import { PageGate } from '@/components/page-gate';
import { PersonAvatar } from '@/components/person-avatar';
import { SectionDialog } from '@/components/setup/section-dialog';
import { useSetupQuery } from '@/components/setup/setup-kit';
import { ShiftDialog } from '@/components/setup/shift-dialog';
import { YearDialog } from '@/components/setup/year-dialog';
import { AddStaffDialog } from '@/components/staff/staff-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage, useLabel, useMeContext } from '@/lib/hooks';
import { displayName, displayUserName } from '@/lib/names';
import { useOnboarding } from '@/lib/setup-checklist';
import { cn } from '@/lib/utils';

/**
 * The new owner's setup wizard (step 8, part 5): six short steps, each done or skipped and saved
 * on its own, so the owner can stop and continue later from the dashboard. Only institutes the
 * platform created have one; anywhere else this page goes to the dashboard.
 */
export default function SetupWizardPage() {
  return (
    <PageGate page="setup">
      <Suspense fallback={<Skeleton className="h-96 rounded-xl" />}>
        <Wizard />
      </Suspense>
    </PageGate>
  );
}

/** After answering `step`: the next open step after it, else the first open one; null if none. */
function nextOpen(o: Onboarding, step: OnboardingStep): OnboardingStep | null {
  return o.steps.slice(o.steps.indexOf(step) + 1).find((s) => !o.states[s]) ?? o.nextStep;
}

/** Mutations a step runs before it is answered; the wizard waits for them. */
const STEP_SAVE = ['onboarding', 'step-save'];

function useOnboardingError() {
  const t = useTranslations('onboarding');
  const describe = useErrorMessage();
  return (e: unknown) =>
    e instanceof ApiError && e.code === 'ONBOARDING_FINISHED' ? t('errorFinished') : describe(e);
}

function Wizard() {
  const t = useTranslations('onboarding');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const message = useOnboardingError();
  const params = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const onboarding = useOnboarding();
  const [finished, setFinished] = useState(false);
  const key = ['onboarding', session?.tenant?.id];

  // No wizard here, or it was finished earlier: nothing to do on this page.
  const closed =
    !finished && onboarding.data && (!onboarding.data.wizard || onboarding.data.completedAt);
  useEffect(() => {
    if (closed) router.replace('/dashboard');
  }, [closed, router]);

  const finish = useMutation({
    mutationFn: () => client.api<Onboarding>('/onboarding/finish', { method: 'POST' }),
    onSuccess: (next) => {
      setFinished(true);
      queryClient.setQueryData(key, next);
      window.scrollTo({ top: 0 });
    },
    onError: (e) => toast.error(message(e)),
  });
  const answer = useMutation({
    mutationFn: ({ step, state }: { step: OnboardingStep; state: OnboardingStepState }) =>
      client.api<Onboarding>(`/onboarding/steps/${step}`, { method: 'PUT', json: { state } }),
    onSuccess: (next, { step }) => {
      queryClient.setQueryData(key, next);
      // The last open step answered (done or skipped) finishes; otherwise on to the next open one.
      const after = nextOpen(next, step);
      if (after) {
        router.push(`/setup/welcome?step=${after}`, { scroll: false });
        window.scrollTo({ top: 0 });
      } else finish.mutate();
    },
    onError: (e) => {
      toast.error(message(e));
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  // A step's own save (the attendance settings) counts too: it answers the step when done.
  const stepSaving = useIsMutating({ mutationKey: STEP_SAVE }) > 0;

  if (finished) return <AllSet />;
  if (onboarding.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{describe(onboarding.error)}</AlertDescription>
      </Alert>
    );
  }
  if (!onboarding.data || !context || closed) return <Skeleton className="h-96 rounded-xl" />;

  const data = onboarding.data;
  const requested = params.get('step') as OnboardingStep | null;
  const current: OnboardingStep =
    requested && data.steps.includes(requested)
      ? requested
      : (data.nextStep ?? data.steps[data.steps.length - 1]!);
  const index = data.steps.indexOf(current);
  // Every other step answered: this answer finishes the wizard (and the buttons say so).
  const final = data.steps.every((s) => s === current || data.states[s]);
  const answered = data.steps.filter((s) => data.states[s]).length;
  const pending = answer.isPending || finish.isPending || stepSaving;
  const actions: StepActionsProps = {
    final,
    pending,
    onSkip: () => answer.mutate({ step: current, state: 'skipped' }),
    onDone: () => answer.mutate({ step: current, state: 'done' }),
  };

  return (
    <div className="flex flex-col gap-5" data-testid="setup-wizard">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-xl font-semibold break-words sm:text-2xl">
            {t('title', { institute: context.tenant.name })}
          </h2>
          <p className="text-muted-foreground">{t('subtitle')}</p>
        </div>
        <ButtonLink
          variant="outline"
          href="/dashboard"
          className="self-start"
          data-testid="wizard-later"
        >
          {t('later')}
        </ButtonLink>
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <StepList
          data={data}
          current={current}
          answered={answered}
          disabled={pending}
          onOpen={(s) => router.push(`/setup/welcome?step=${s}`, { scroll: false })}
        />
        <section
          className="bg-card flex min-w-0 flex-col gap-5 rounded-xl border p-4 shadow-xs sm:p-6"
          aria-labelledby="wizard-step-title"
          data-testid={`wizard-step-${current}`}
        >
          <p className="text-primary-ink text-sm font-semibold">
            {t('stepOf', {
              n: formatCount(index + 1, locale),
              total: formatCount(data.steps.length, locale),
            })}
            {data.states[current] && (
              <span className="text-muted-foreground font-normal">
                {' · '}
                {data.states[current] === 'done' ? t('stateDone') : t('stateSkipped')}
              </span>
            )}
          </p>
          {current === 'year' && <YearStep {...actions} />}
          {current === 'classes' && <ClassesStep {...actions} />}
          {current === 'shifts' && <ShiftsStep {...actions} />}
          {current === 'teachers' && <TeachersStep context={context} {...actions} />}
          {current === 'students' && <StudentsStep {...actions} />}
          {current === 'attendance' && <AttendanceStep {...actions} />}
        </section>
      </div>
    </div>
  );
}

/** The six steps: a column beside the step on wide screens, numbered circles on phones. */
function StepList({
  data,
  current,
  answered,
  disabled,
  onOpen,
}: {
  data: Onboarding;
  current: OnboardingStep;
  answered: number;
  disabled: boolean;
  onOpen: (step: OnboardingStep) => void;
}) {
  const t = useTranslations('onboarding');
  const locale = useLocale() as Locale;
  const titles = useStepTitles();
  return (
    <nav aria-label={t('stepsLabel')} className="flex flex-col gap-3">
      <div
        className="bg-muted h-2 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={data.steps.length}
        aria-valuenow={answered}
        aria-label={t('progress', {
          done: formatCount(answered, locale),
          total: formatCount(data.steps.length, locale),
        })}
      >
        <div
          className="bg-primary h-full rounded-full transition-[width] duration-500"
          style={{ width: `${(answered / data.steps.length) * 100}%` }}
        />
      </div>
      <ol className="flex justify-between gap-1 lg:flex-col lg:gap-1">
        {data.steps.map((s, i) => {
          const state = data.states[s];
          const active = s === current;
          return (
            <li key={s} className="lg:w-full">
              <button
                type="button"
                onClick={() => onOpen(s)}
                disabled={disabled}
                aria-current={active ? 'step' : undefined}
                aria-label={`${titles[s]}${state ? ` (${state === 'done' ? t('stateDone') : t('stateSkipped')})` : ''}`}
                className={cn(
                  'flex items-center gap-3 rounded-lg text-start transition-colors outline-none',
                  'focus-visible:ring-ring focus-visible:ring-3',
                  'lg:hover:bg-muted lg:w-full lg:px-2 lg:py-2',
                  active && 'lg:bg-primary-soft/60',
                )}
                data-testid={`wizard-nav-${s}`}
              >
                <span
                  className={cn(
                    'font-numeric flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
                    state === 'done'
                      ? 'bg-success-soft text-success'
                      : state === 'skipped'
                        ? 'bg-muted text-muted-foreground'
                        : 'border',
                    active && 'ring-primary-ink ring-offset-background ring-2 ring-offset-2',
                  )}
                >
                  {state === 'done' ? (
                    <CheckIcon aria-hidden className="size-4" />
                  ) : state === 'skipped' ? (
                    <MinusIcon aria-hidden className="size-4" />
                  ) : (
                    formatCount(i + 1, locale)
                  )}
                </span>
                <span
                  className={cn(
                    'hidden min-w-0 text-sm lg:block',
                    active ? 'font-semibold' : 'text-muted-foreground',
                  )}
                >
                  {titles[s]}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function useStepTitles(): Record<OnboardingStep, string> {
  const t = useTranslations('onboarding');
  const label = useLabel();
  return {
    year: t('yearTitle', { year: label('academic_year', 'Academic Year', { inText: true }) }),
    classes: t('classesTitle', {
      classLevel: label('class_level', 'Class'),
      section: label('section', 'Section', { inText: true }),
    }),
    shifts: t('shiftsTitle', { shift: label('shift', 'Shift') }),
    teachers: t('teachersTitle'),
    students: t('studentsTitle', { student: label('student', 'Student', { inText: true }) }),
    attendance: t('attendanceTitle'),
  };
}

interface StepActionsProps {
  /** Every other step is answered: this one finishes the wizard. */
  final: boolean;
  pending: boolean;
  onSkip: () => void;
  onDone: () => void;
}

/** Title, text, the step's own content, then skip / done (finish once every other step is answered). */
function Step({
  step,
  text,
  children,
  actions,
  onDone,
}: {
  step: OnboardingStep;
  text: string;
  children: ReactNode;
  actions: StepActionsProps;
  /** Replaces the plain "done" (e.g. save the settings first). */
  onDone?: () => void;
}) {
  const t = useTranslations('onboarding');
  const titles = useStepTitles();
  return (
    <>
      <div className="-mt-3 flex flex-col gap-1">
        <h3 id="wizard-step-title" className="text-lg font-semibold sm:text-xl">
          {titles[step]}
        </h3>
        <p className="text-muted-foreground">{text}</p>
      </div>
      {children}
      <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          disabled={actions.pending}
          onClick={actions.onSkip}
          data-testid="wizard-skip"
        >
          {actions.final ? t('skipAndFinish') : t('skip')}
        </Button>
        <Button
          type="button"
          disabled={actions.pending}
          onClick={onDone ?? actions.onDone}
          data-testid="wizard-done"
        >
          {actions.final ? t('finish') : t('next')}
        </Button>
      </div>
    </>
  );
}

function Loading({ error }: { error?: unknown }) {
  const describe = useErrorMessage();
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{describe(error)}</AlertDescription>
      </Alert>
    );
  }
  return <Skeleton className="h-32" />;
}

/** A plain bordered list for what a step has added so far. */
function Rows({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <ul className="divide-y rounded-lg border" data-testid={testId}>
      {children}
    </ul>
  );
}

function YearStep(actions: StepActionsProps) {
  const t = useTranslations('onboarding');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const years = useSetupQuery<SetupAcademicYear[]>('/setup/academic-years');
  const [editing, setEditing] = useState<SetupAcademicYear | 'new' | null>(null);
  const yearInText = label('academic_year', 'Academic Year', { inText: true });
  const year = years.data?.find((y) => y.isCurrent) ?? years.data?.[0];
  return (
    <Step step="year" text={t('yearText')} actions={actions}>
      {!years.data ? (
        <Loading error={years.error} />
      ) : year ? (
        <div className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-lg font-semibold" data-testid="wizard-year-name">
              {year.name}
            </span>
            <span className="text-muted-foreground text-sm">
              {t('yearRange', {
                start: formatDate(dateToDb(year.startDate), locale, 'long'),
                end: formatDate(dateToDb(year.endDate), locale, 'long'),
              })}
            </span>
          </div>
          <Button
            variant="outline"
            className="self-start sm:self-auto"
            onClick={() => setEditing(year)}
            data-testid="wizard-year-edit"
          >
            <PencilIcon aria-hidden />
            {t('yearEdit')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground text-sm">{t('yearNone', { year: yearInText })}</p>
          <Button variant="outline" onClick={() => setEditing('new')}>
            <PlusIcon aria-hidden />
            {t('yearAdd', { year: yearInText })}
          </Button>
        </div>
      )}
      {editing && (
        <YearDialog year={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </Step>
  );
}

function ClassesStep(actions: StepActionsProps) {
  const t = useTranslations('onboarding');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const years = useSetupQuery<SetupAcademicYear[]>('/setup/academic-years');
  const classLevels = useSetupQuery<SetupClassLevel[]>('/setup/class-levels');
  const shifts = useSetupQuery<SetupShift[]>('/setup/shifts');
  const year = years.data?.find((y) => y.isCurrent) ?? years.data?.[0];
  const sections = useSetupQuery<SetupSection[]>(
    year ? `/setup/sections?academicYearId=${year.id}` : null,
  );
  const [adding, setAdding] = useState<SetupClassLevel | null>(null);
  const classLevel = label('class_level', 'Class', { inText: true });
  const section = label('section', 'Section', { inText: true });
  const ready = years.data && classLevels.data && (sections.data || !year);
  return (
    <Step step="classes" text={t('classesText', { classLevel, section })} actions={actions}>
      {!ready ? (
        <Loading error={years.error ?? classLevels.error ?? sections.error} />
      ) : (
        <Rows testId="wizard-classes">
          {classLevels
            .data!.filter((c) => c.isActive)
            .map((c) => {
              const own = (sections.data ?? []).filter((s) => s.classLevelId === c.id);
              const name = displayName(c.nameBn, c.nameEn, locale);
              return (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2.5 sm:px-4"
                  data-testid="wizard-class"
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="font-medium">{name}</span>
                    <span className="flex flex-wrap gap-1.5">
                      {own.length === 0 ? (
                        <span className="text-muted-foreground text-sm">
                          {t('noSections', { section })}
                        </span>
                      ) : (
                        own.map((s) => (
                          <Badge key={s.id} variant="secondary">
                            {s.name}
                          </Badge>
                        ))
                      )}
                    </span>
                  </span>
                  {year && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setAdding(c)}
                      aria-label={`${t('addSection', { section })}: ${name}`}
                    >
                      <PlusIcon aria-hidden />
                      {t('addSection', { section })}
                    </Button>
                  )}
                </li>
              );
            })}
        </Rows>
      )}
      {adding && year && (
        <SectionDialog
          yearId={year.id}
          classLevel={adding}
          item={null}
          shifts={(shifts.data ?? []).filter((s) => s.isActive)}
          onClose={() => setAdding(null)}
        />
      )}
    </Step>
  );
}

function ShiftsStep(actions: StepActionsProps) {
  const t = useTranslations('onboarding');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const shifts = useSetupQuery<SetupShift[]>('/setup/shifts');
  const [adding, setAdding] = useState(false);
  const shift = label('shift', 'Shift', { inText: true });
  const active = shifts.data?.filter((s) => s.isActive);
  return (
    <Step step="shifts" text={t('shiftsText', { shift })} actions={actions}>
      {!active ? (
        <Loading error={shifts.error} />
      ) : (
        <div className="flex flex-col items-start gap-3">
          {active.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noShifts', { shift })}</p>
          ) : (
            <div className="w-full">
              <Rows testId="wizard-shifts">
                {active.map((s) => (
                  <li
                    key={s.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 sm:px-4"
                  >
                    <span className="font-medium">{displayName(s.nameBn, s.nameEn, locale)}</span>
                    <span className="text-muted-foreground font-numeric text-sm">
                      {formatWallClock(s.startTime, locale)} – {formatWallClock(s.endTime, locale)}
                    </span>
                  </li>
                ))}
              </Rows>
            </div>
          )}
          <Button variant="outline" onClick={() => setAdding(true)} data-testid="wizard-add-shift">
            <PlusIcon aria-hidden />
            {t('addShift', { shift })}
          </Button>
        </div>
      )}
      {adding && <ShiftDialog item={null} onClose={() => setAdding(false)} />}
    </Step>
  );
}

function TeachersStep({ context, ...actions }: StepActionsProps & { context: MeContext }) {
  const t = useTranslations('onboarding');
  const tStaff = useTranslations('staff');
  const tRoles = useTranslations('roles');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const staff = useQuery({
    queryKey: ['staff', session?.tenant?.id],
    queryFn: () => client.api<StaffMember[]>('/staff'),
  });
  const [adding, setAdding] = useState(false);
  const others = staff.data?.filter((m) => !m.isSelf);
  return (
    <Step step="teachers" text={t('teachersText')} actions={actions}>
      {!others ? (
        <Loading error={staff.error} />
      ) : (
        <div className="flex flex-col items-start gap-3">
          {others.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noTeachers')}</p>
          ) : (
            <div className="w-full">
              <Rows testId="wizard-staff">
                {others.map((m) => (
                  <li key={m.userId} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
                    <PersonAvatar name={displayUserName(m, locale)} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium">{displayUserName(m, locale)}</span>
                      <span className="text-muted-foreground truncate text-sm">
                        {m.roles.map((r) => tRoles(r)).join(', ')}
                      </span>
                    </span>
                    {m.status === 'DISABLED' ? (
                      <Badge variant="warning" className="shrink-0">
                        {tStaff('inactive')}
                      </Badge>
                    ) : (
                      m.status !== 'ACTIVE' && (
                        <Badge variant="soft" className="shrink-0">
                          {tStaff(`status${m.status}`)}
                        </Badge>
                      )
                    )}
                  </li>
                ))}
              </Rows>
            </div>
          )}
          <Button variant="outline" onClick={() => setAdding(true)} data-testid="wizard-add-staff">
            <PlusIcon aria-hidden />
            {t('addTeacher')}
          </Button>
        </div>
      )}
      {adding && (
        <AddStaffDialog
          callerIsOwner={context.roles.includes('OWNER')}
          onClose={() => setAdding(false)}
        />
      )}
    </Step>
  );
}

function StudentsStep(actions: StepActionsProps) {
  const t = useTranslations('onboarding');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const { client, session } = useAuth();
  const students = useQuery({
    queryKey: ['students-total', session?.tenant?.id],
    queryFn: () => client.api<StudentsPage>('/students?pageSize=1'),
  });
  const student = label('student', 'Student', { inText: true });
  return (
    <Step step="students" text={t('studentsText', { student })} actions={actions}>
      <div className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-3">
          <span className="bg-primary-soft text-primary-ink flex size-10 shrink-0 items-center justify-center rounded-lg">
            <FileSpreadsheetIcon aria-hidden className="size-5" />
          </span>
          <span className="text-sm" data-testid="wizard-student-count">
            {students.data
              ? t('studentsCount', { count: formatCount(students.data.total ?? 0, locale) })
              : '…'}
          </span>
        </span>
        <ButtonLink
          variant="outline"
          href="/students/import?from=setup"
          className="self-start sm:self-auto"
          data-testid="wizard-import"
        >
          {t('importButton')}
        </ButtonLink>
      </div>
    </Step>
  );
}

function AttendanceStep(actions: StepActionsProps) {
  const t = useTranslations('onboarding');
  const tSettings = useTranslations('attendanceSettings');
  const label = useLabel();
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const queryClient = useQueryClient();
  const key = ['attendance-settings', session?.tenant?.id];
  const settings = useQuery({
    queryKey: key,
    queryFn: () => client.api<AttendanceSettings>('/attendance/settings'),
  });
  const [mode, setMode] = useState<AttendanceMode | null>(null);
  const [sms, setSms] = useState<boolean | null>(null);
  const save = useMutation({
    mutationKey: STEP_SAVE,
    mutationFn: (s: AttendanceSettings) =>
      client.api<AttendanceSettings>('/attendance/settings', {
        method: 'PUT',
        json: {
          mode: mode ?? s.mode,
          weeklyOffDays: s.weeklyOffDays,
          editWindowDays: s.editWindowDays,
          leaveCountsAsAbsent: s.leaveCountsAsAbsent,
          absentSmsEnabled: sms ?? s.absentSmsEnabled,
          absentSmsTemplate: s.absentSmsTemplate,
          absentSmsDelayMinutes: s.absentSmsDelayMinutes,
          dailySmsCap: s.dailySmsCap,
        },
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(key, next);
      for (const k of [
        'attendance-summary',
        'attendance-report-today',
        'attendance-trend',
        'sms-today',
      ])
        void queryClient.invalidateQueries({ queryKey: [k] });
      actions.onDone();
    },
    onError: (e) => toast.error(describe(e)),
  });
  const s = settings.data;
  const changed =
    s && ((mode !== null && mode !== s.mode) || (sms !== null && sms !== s.absentSmsEnabled));
  const student = label('student', 'Student', { inText: true });
  return (
    <Step
      step="attendance"
      text={t('attendanceText', { student })}
      actions={{ ...actions, pending: actions.pending || save.isPending }}
      onDone={s ? () => (changed ? save.mutate(s) : actions.onDone()) : undefined}
    >
      {!s ? (
        <Loading error={settings.error} />
      ) : (
        <div className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{tSettings('mode')}</legend>
            <div className="flex flex-wrap gap-2">
              {(['DAILY', 'PER_SESSION'] as AttendanceMode[]).map((m) => (
                <ChoiceChip
                  key={m}
                  type="radio"
                  name="wizard-mode"
                  checked={(mode ?? s.mode) === m}
                  onChange={() => setMode(m)}
                >
                  {tSettings(`mode${m}`)}
                </ChoiceChip>
              ))}
            </div>
          </fieldset>
          <ToggleField
            id="wizard-sms"
            checked={sms ?? s.absentSmsEnabled}
            onChange={setSms}
            label={tSettings('smsEnabled')}
            hint={tSettings('smsHint')}
          />
          <p className="text-muted-foreground text-sm">{t('attendanceMore')}</p>
        </div>
      )}
    </Step>
  );
}

function AllSet() {
  const t = useTranslations('onboarding');
  return (
    <div
      className="bg-card flex flex-col items-center gap-3 rounded-xl border px-6 py-14 text-center shadow-xs"
      data-testid="wizard-finished"
    >
      <span className="bg-success-soft text-success flex size-14 items-center justify-center rounded-2xl">
        <PartyPopperIcon aria-hidden className="size-7" />
      </span>
      <h2 className="text-xl font-semibold">{t('doneTitle')}</h2>
      <p className="text-muted-foreground max-w-md">{t('doneText')}</p>
      <ButtonLink className="mt-2" href="/dashboard">
        {t('toDashboard')}
      </ButtonLink>
    </div>
  );
}

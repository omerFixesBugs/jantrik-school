'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  formatCount,
  formatTaka,
  type FeeReminderPreview,
  type FeeReminderRun,
  type FeeReminderStatus,
  type StudentFilters,
} from '@jantrik/shared';
import {
  BanIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  HourglassIcon,
  MessageSquareTextIcon,
  CirclePauseIcon,
  SendIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import { SelectField } from '@/components/form-kit';
import { Pill, type PillTone } from '@/components/kit/pill';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Locale } from '@/i18n/config';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { pick } from '@/lib/fees';
import { useErrorMessage, useLabel } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { useUrlParams } from '@/lib/view-state';
import { intParam, LoadError, useMinDaysOptions } from './kit';

/*
 * Due reminder SMS (docs/fees.md → Reminders), OWNER/ADMIN: choose who (class, section, how
 * late), count first (who would get one, who has no phone, who was reminded already, the SMS
 * and their cost against today's cap, one message as it will read), then send after a confirm
 * that repeats the count and the cost, and watch the run until nothing is waiting.
 */

type Filter = { classLevelId?: string; sectionId?: string; minDays: number };
type RunCounts = FeeReminderStatus['counts'];

export function ReminderComposer() {
  const t = useTranslations('fees.reports.reminders');
  const tc = useTranslations('fees.reports.common');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const describe = useErrorMessage();
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  const id = useId();
  const { params, set } = useUrlParams();

  const classes = useQuery({
    queryKey: ['student-filters', tenantId],
    queryFn: () => client.api<StudentFilters>('/students/filters'),
  });
  const chosenClass = classes.data?.classLevels.find((c) => c.id === params.get('class')) ?? null;
  const chosenSection = chosenClass?.sections.find((s) => s.id === params.get('section')) ?? null;
  const minDays = intParam(params.get('days'), 1, 1, 3650);
  const filter: Filter = {
    ...(chosenClass ? { classLevelId: chosenClass.id } : {}),
    ...(chosenSection ? { sectionId: chosenSection.id } : {}),
    minDays,
  };
  const filterKey = JSON.stringify(filter);
  const daysOptions = useMinDaysOptions(minDays);

  const [preview, setPreview] = useState<{ key: string; data: FeeReminderPreview } | null>(null);
  const [changedTo, setChangedTo] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const count = useMutation({
    mutationFn: (f: Filter) =>
      client.api<FeeReminderPreview>('/fees/reminders/preview', { method: 'POST', json: f }),
    onSuccess: (data, f) => setPreview({ key: JSON.stringify(f), data }),
  });
  const stale = Boolean(preview && preview.key !== filterKey);

  const send = useMutation({
    mutationFn: () =>
      client.api<FeeReminderRun>('/fees/reminders', {
        method: 'POST',
        json: { ...filter, expectedRecipients: preview!.data.toSend },
      }),
    onSuccess: (run) => {
      setConfirming(false);
      setPreview(null);
      setChangedTo(null);
      set({ run: run.runId, n: String(run.queued) });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'PREVIEW_CHANGED') {
        // Someone paid (or a number was added) meanwhile: the new count, before anything goes.
        setConfirming(false);
        setChangedTo((e.body as { toSend?: number } | undefined)?.toSend ?? null);
        count.mutate(filter);
      }
    },
  });
  const sendError =
    send.error && !(send.error instanceof ApiError && send.error.code === 'PREVIEW_CHANGED')
      ? describe(send.error)
      : null;

  const runId = params.get('run');
  const queued = intParam(params.get('n'), 0, 0, 1_000_000);
  const p = preview?.data;
  const f = (n: number) => formatCount(n, locale);
  const people = (n: number) => t('peopleValue', { count: f(n), n });
  const classLabel = label('class_level', 'Class');
  const sectionLabel = label('section', 'Section');

  return (
    <>
      <header className="flex min-w-0 flex-col gap-1">
        <h2 className="text-xl font-semibold">{t('title')}</h2>
        <p className="text-muted-foreground max-w-prose text-sm">{t('intro')}</p>
      </header>

      {runId && (
        <RunStatus
          key={runId}
          runId={runId}
          queued={queued}
          onClose={() => set({ run: null, n: null })}
        />
      )}

      <section
        data-slot="card"
        className="bg-card rounded-card shadow-card flex min-w-0 flex-col gap-4 border p-(--panel-p)"
        aria-labelledby={`${id}-who`}
      >
        <h3 id={`${id}-who`} className="text-base font-semibold">
          {t('who')}
        </h3>
        {classes.isError ? (
          <LoadError error={classes.error} onRetry={() => void classes.refetch()} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <SelectField
              id={`${id}-class`}
              label={classLabel}
              value={chosenClass?.id ?? ''}
              disabled={classes.isPending}
              onChange={(v) => set({ class: v || null, section: null })}
              options={[
                {
                  value: '',
                  label: tc('allClasses', {
                    classLevel: label('class_level', 'Class', { inText: true }),
                  }),
                },
                ...(classes.data?.classLevels ?? []).map((c) => ({
                  value: c.id,
                  label: pick(locale, c),
                })),
              ]}
            />
            <SelectField
              id={`${id}-section`}
              label={sectionLabel}
              value={chosenSection?.id ?? ''}
              disabled={!chosenClass || chosenClass.sections.length === 0}
              onChange={(v) => set({ section: v || null })}
              options={[
                {
                  value: '',
                  label: tc('allSections', {
                    section: label('section', 'Section', { inText: true }),
                  }),
                },
                ...(chosenClass?.sections ?? []).map((s) => ({ value: s.id, label: s.name })),
              ]}
            />
            <SelectField
              id={`${id}-days`}
              label={tc('minDays')}
              value={String(minDays)}
              onChange={(v) => set({ days: v === '1' ? null : v })}
              options={daysOptions}
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant={p && !stale ? 'outline' : 'default'}
            onClick={() => {
              setChangedTo(null);
              count.mutate(filter);
            }}
            disabled={count.isPending || classes.isPending}
            data-testid="reminders-preview"
          >
            <MessageSquareTextIcon aria-hidden />
            {p ? t('previewAgain') : t('preview')}
          </Button>
          {stale && (
            <p className="text-warning flex items-center gap-1.5 text-sm" role="status">
              <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
              {t('stale')}
            </p>
          )}
        </div>
        {count.isError && <LoadError error={count.error} onRetry={() => count.mutate(filter)} />}
      </section>

      {p && (
        <section
          data-slot="card"
          className={cn(
            'bg-card rounded-card shadow-card flex min-w-0 flex-col gap-4 border p-(--panel-p) transition-opacity',
            (stale || count.isPending) && 'opacity-60',
          )}
          aria-labelledby={`${id}-result`}
          aria-busy={count.isPending || undefined}
          data-testid="reminders-result"
        >
          <h3 id={`${id}-result`} className="text-base font-semibold">
            {t('resultTitle')}
          </h3>
          {changedTo !== null && (
            <Alert>
              <AlertDescription>{t('changed', { count: f(changedTo) })}</AlertDescription>
            </Alert>
          )}
          <dl className="grid grid-cols-2 gap-(--gap) lg:grid-cols-4">
            <Figure term={t('students')} value={people(p.students)} testId="reminders-students" />
            <Figure term={t('withoutPhone')} value={people(p.withoutPhone)} />
            <Figure term={t('alreadyReminded')} value={people(p.alreadyReminded)} />
            <Figure term={t('toSend')} value={people(p.toSend)} strong testId="reminders-to-send" />
          </dl>
          <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">
              {t('segments')}
              <span className="block text-xs">{t('segmentsHint')}</span>
            </dt>
            <dd className="font-numeric self-start text-end font-medium">
              {t('segmentsValue', { count: f(p.segments), n: p.segments })}
            </dd>
            <dt className="text-muted-foreground">{t('cost')}</dt>
            <dd className="font-numeric text-end font-semibold" data-testid="reminders-cost">
              {formatTaka(p.costPaisa, locale)}
            </dd>
            <dt className="text-muted-foreground">{t('capLeft')}</dt>
            <dd className="font-numeric text-end font-medium">
              {t('capLeftValue', { count: f(p.capLeftToday), n: p.capLeftToday })}
            </dd>
          </dl>
          {p.wouldBeHeld > 0 && (
            <p
              className="border-warning/40 bg-warning-soft flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
              data-testid="reminders-held"
            >
              <TriangleAlertIcon aria-hidden className="text-warning mt-0.5 size-4 shrink-0" />
              {t('wouldBeHeld', { count: f(p.wouldBeHeld), n: p.wouldBeHeld })}
            </p>
          )}
          {p.sampleText && (
            <figure className="flex max-w-md flex-col gap-1.5">
              <figcaption className="text-muted-foreground text-sm">{t('sample')}</figcaption>
              <blockquote
                className="bg-muted rounded-xl rounded-ss-sm px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap"
                data-testid="reminders-sample"
              >
                {p.sampleText}
              </blockquote>
            </figure>
          )}
          {p.toSend === 0 ? (
            <div className="flex flex-col gap-0.5">
              <p className="font-medium">{p.students === 0 ? t('nobody') : t('noneToSend')}</p>
              {p.students > 0 && (
                <p className="text-muted-foreground text-sm">{t('noneToSendHint')}</p>
              )}
            </div>
          ) : (
            <Button
              className="self-start"
              onClick={() => {
                send.reset();
                setConfirming(true);
              }}
              disabled={stale || count.isPending}
              data-testid="reminders-send"
            >
              <SendIcon aria-hidden />
              {t('send', { count: f(p.toSend), n: p.toSend })}
            </Button>
          )}
        </section>
      )}

      {p && (
        <Dialog open={confirming} onOpenChange={setConfirming}>
          <DialogContent data-testid="reminders-confirm-dialog">
            <DialogHeader>
              <DialogTitle>{t('confirmTitle', { count: f(p.toSend), n: p.toSend })}</DialogTitle>
              <DialogDescription>{t('confirmBody')}</DialogDescription>
            </DialogHeader>
            <dl className="bg-muted/50 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-lg px-3 py-2 text-sm">
              <dt className="text-muted-foreground">{t('confirmMessages')}</dt>
              <dd className="font-numeric text-end font-medium">{people(p.toSend)}</dd>
              <dt className="text-muted-foreground">{t('confirmSegments')}</dt>
              <dd className="font-numeric text-end font-medium">
                {t('segmentsValue', { count: f(p.segments), n: p.segments })}
              </dd>
              <dt className="text-muted-foreground">{t('confirmCost')}</dt>
              <dd className="font-numeric text-end font-semibold">
                {formatTaka(p.costPaisa, locale)}
              </dd>
            </dl>
            {p.wouldBeHeld > 0 && (
              <p className="flex items-start gap-2 text-sm">
                <TriangleAlertIcon aria-hidden className="text-warning mt-0.5 size-4 shrink-0" />
                {t('wouldBeHeld', { count: f(p.wouldBeHeld), n: p.wouldBeHeld })}
              </p>
            )}
            {sendError && (
              <Alert variant="destructive">
                <AlertDescription>{sendError}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                {t('confirmNo')}
              </Button>
              <Button
                onClick={() => send.mutate()}
                disabled={send.isPending}
                data-testid="reminders-confirm"
              >
                {t('confirmYes')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/** One count of the preview: the figure big and light, what it is under it. */
function Figure({
  term,
  value,
  strong = false,
  testId,
}: {
  term: string;
  value: string;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-1 rounded-xl border px-3 py-2.5',
        strong ? 'bg-primary-soft border-transparent' : 'bg-card',
      )}
      data-testid={testId}
    >
      <dt
        className={cn('text-sm', strong ? 'text-primary-ink font-medium' : 'text-muted-foreground')}
      >
        {term}
      </dt>
      <dd className="font-numeric text-2xl leading-tight font-light">{value}</dd>
    </div>
  );
}

const RUN_STATUS: { key: keyof RunCounts; icon: LucideIcon; tone: PillTone }[] = [
  { key: 'SENT', icon: CircleCheckIcon, tone: 'success' },
  { key: 'QUEUED', icon: HourglassIcon, tone: 'neutral' },
  { key: 'FAILED', icon: CircleXIcon, tone: 'destructive' },
  { key: 'HELD_OVER_LIMIT', icon: CirclePauseIcon, tone: 'warning' },
  { key: 'CANCELLED', icon: BanIcon, tone: 'neutral' },
  { key: 'EXPIRED', icon: ClockIcon, tone: 'neutral' },
];
/** Every 2 s for up to 2 minutes; the person can look again after that. */
const POLL_MS = 2_000;
const MAX_POLLS = 60;

const total = (c: RunCounts) => Object.values(c).reduce((s, n) => s + n, 0);

/**
 * A run's live status: polled every 2 s until nothing is waiting. The job queues the messages a
 * moment after the send, so "nothing waiting" counts only once the messages are there (or have
 * stopped changing: a guardian may have paid in between and been skipped).
 */
function RunStatus({
  runId,
  queued,
  onClose,
}: {
  runId: string;
  queued: number;
  onClose: () => void;
}) {
  const t = useTranslations('fees.reports.reminders');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const { client } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    data: FeeReminderStatus | null;
    error: unknown;
    finished: boolean;
    gaveUp: boolean;
  }>({ data: null, error: null, finished: false, gaveUp: false });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    let same = 0;
    let last = '';
    const tick = async () => {
      polls += 1;
      try {
        const data = await client.api<FeeReminderStatus>(`/fees/reminders/${runId}`);
        if (cancelled) return;
        const sig = JSON.stringify(data.counts);
        same = sig === last ? same + 1 : 0;
        last = sig;
        const all = total(data.counts);
        const finished = data.counts.QUEUED === 0 && (all >= queued || (all > 0 && same >= 3));
        const gaveUp = !finished && polls >= MAX_POLLS;
        setState({ data, error: null, finished, gaveUp });
        if (!finished && !gaveUp) timer = setTimeout(() => void tick(), POLL_MS);
      } catch (error) {
        if (cancelled) return;
        const gaveUp = polls >= MAX_POLLS;
        setState((s) => ({ ...s, error, gaveUp }));
        if (!gaveUp) timer = setTimeout(() => void tick(), POLL_MS * 2);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, runId, queued, attempt]);

  const { data, finished, gaveUp } = state;
  const f = (n: number) => formatCount(n, locale);
  const all = data ? total(data.counts) : 0;
  const whole = Math.max(queued, all);
  const done = data ? all - data.counts.QUEUED : 0;
  const line = finished
    ? all === 0
      ? t('runNothing')
      : t('runDone')
    : gaveUp
      ? t('runStopped')
      : t('runWorking');
  const progress = t('runProgress', { done: f(done), total: f(whole) });

  return (
    <section
      data-slot="card"
      className="bg-card rounded-card shadow-card flex min-w-0 flex-col gap-3 border p-(--panel-p)"
      aria-labelledby={`run-${runId}`}
      data-testid="reminders-run"
      data-finished={finished || undefined}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id={`run-${runId}`} className="text-base font-semibold">
          {t('runTitle')}
        </h3>
        <p className="text-muted-foreground text-sm">
          {t('runQueued', { count: f(queued), n: queued })}
        </p>
      </div>
      <p className="font-medium" role="status" aria-live="polite">
        {line}
      </p>
      {whole > 0 && (
        <div className="flex flex-col gap-1.5">
          <div
            className="bg-muted h-2 overflow-hidden rounded-full"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={whole}
            aria-valuenow={done}
            aria-valuetext={progress}
          >
            <div
              className="bg-primary h-full rounded-full transition-[width] duration-500"
              style={{ width: `${whole > 0 ? (done / whole) * 100 : 0}%` }}
            />
          </div>
          <p className="text-muted-foreground text-sm">{progress}</p>
        </div>
      )}
      {data && (
        <ul className="flex flex-wrap gap-2" data-testid="reminders-run-counts">
          {RUN_STATUS.filter((s) => s.key === 'SENT' || data.counts[s.key] > 0).map(
            ({ key, icon: Icon, tone }) => (
              <li key={key} data-status={key} data-count={data.counts[key]}>
                <Pill tone={tone} className="text-sm">
                  <Icon aria-hidden className="size-3.5 shrink-0" />
                  {t(`status.${key}`)}: <span className="font-numeric">{f(data.counts[key])}</span>
                </Pill>
              </li>
            ),
          )}
        </ul>
      )}
      {state.error != null && !finished && (
        <p className="text-destructive text-sm">{describe(state.error)}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {gaveUp && (
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            {t('runRefresh')}
          </Button>
        )}
        {(finished || gaveUp) && (
          <Button variant="outline" onClick={onClose}>
            {t('runClose')}
          </Button>
        )}
      </div>
    </section>
  );
}

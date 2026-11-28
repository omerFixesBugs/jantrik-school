'use client';

import { useQuery } from '@tanstack/react-query';
import {
  formatCount,
  formatIdentifier,
  LEAVE_STATUSES,
  ROLL_STRATEGIES,
  type LeaveStatus,
  type PromotionApplyCheck,
  type PromotionDecision,
  type PromotionRowView,
  type PromotionRunDetail,
  type RollStrategy,
  type SetupClassLevel,
  type SetupSection,
} from '@jantrik/shared';
import {
  ArrowLeftIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
} from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { SectionCard, SelectField } from '@/components/form-kit';
import { DateInput } from '@/components/date-input';
import { Pill } from '@/components/kit/pill';
import { PageGate } from '@/components/page-gate';
import { pick, usePromotionMutation, useStopReason } from '@/components/promotion/kit';
import { ConfirmDialog, useSetupQuery } from '@/components/setup/setup-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useLabel } from '@/lib/hooks';
import { runEditable } from '@/lib/promotion/run-state';
import { cn } from '@/lib/utils';

/** What the admin changed on a row (sent with PUT /promotions/:id/rows). */
interface Edit {
  decision: PromotionDecision;
  targetClassLevelId: string | null;
  targetSectionId: string | null;
  targetStudyGroupId: string | null;
  leaveStatus: LeaveStatus | null;
  leftOn: string | null;
  leaveReason: string | null;
}

type Filter = 'all' | PromotionDecision | 'noResult' | 'noSection';

const fromRow = (r: PromotionRowView): Edit => ({
  decision: r.decision,
  targetClassLevelId: r.targetClassLevel?.id ?? null,
  targetSectionId: r.targetSection?.id ?? null,
  targetStudyGroupId: r.targetStudyGroup?.id ?? null,
  leaveStatus: r.leaveStatus,
  leftOn: r.leftOn,
  leaveReason: r.leaveReason,
});

/**
 * One class's promotion run (P5): every student with their result, the decision and the target,
 * edited in place (on a phone each row stacks), saved together; then apply, with progress and a
 * resume when it stopped.
 */
export default function PromotionRunPage() {
  return (
    <PageGate page="setup">
      <Run />
    </PageGate>
  );
}

function Run() {
  const t = useTranslations('promotion.run');
  const tStatus = useTranslations('studentStatus');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const { runId } = useParams<{ runId: string }>();
  const { client, session } = useAuth();
  const stopReason = useStopReason();
  const f = (n: number) => formatCount(n, locale);
  const run = useQuery({
    queryKey: ['promotion', session?.tenant?.id, 'run', runId],
    queryFn: () => client.api<PromotionRunDetail>(`/promotions/${runId}`),
    refetchInterval: (q) => (q.state.data?.status === 'APPLYING' ? 2_000 : false),
  });
  const data = run.data;
  const sections = useSetupQuery<SetupSection[]>(
    data ? `/setup/sections?academicYearId=${data.toYear.id}` : null,
  );
  const classes = useSetupQuery<SetupClassLevel[]>('/setup/class-levels');
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [invalid, setInvalid] = useState<Set<string>>(new Set());

  const check = useQuery({
    queryKey: ['promotion', session?.tenant?.id, 'apply-check', runId, data?.counts.pending],
    queryFn: () => client.api<PromotionApplyCheck>(`/promotions/${runId}/apply-check`),
    enabled: Boolean(data && data.status !== 'APPLYING' && data.counts.pending > 0),
  });

  const save = usePromotionMutation(
    () =>
      client.api<PromotionRunDetail>(`/promotions/${runId}/rows`, {
        method: 'PUT',
        json: { rows: Object.entries(edits).map(([id, e]) => ({ id, ...e })) },
      }),
    {
      success: t('saved'),
      onSuccess: () => {
        setEdits({});
        setInvalid(new Set());
      },
      onError: (e) => {
        const ids = (e as { body?: { rowIds?: string[] } }).body?.rowIds;
        if (ids) setInvalid(new Set(ids));
      },
    },
  );
  const refresh = usePromotionMutation(
    () => client.api<PromotionRunDetail>(`/promotions/${runId}/refresh`, { method: 'POST' }),
    { success: t('refreshed') },
  );
  const strategy = usePromotionMutation((rollStrategy: RollStrategy) =>
    client.api<PromotionRunDetail>(`/promotions/${runId}`, {
      method: 'PATCH',
      json: { rollStrategy },
    }),
  );
  const apply = usePromotionMutation(() =>
    client.api<PromotionRunDetail>(`/promotions/${runId}/apply`, {
      method: 'POST',
      json: { version: check.data!.version },
    }),
  );
  const resume = usePromotionMutation(() =>
    client.api<PromotionRunDetail>(`/promotions/${runId}/resume`, { method: 'POST' }),
  );
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const remove = usePromotionMutation(
    () => client.api(`/promotions/${runId}`, { method: 'DELETE' }),
    { success: t('deleted'), onSuccess: () => router.push('/setup/new-year') },
  );

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const current = (r: PromotionRowView): Edit => edits[r.id] ?? fromRow(r);
  const shown = rows.filter((r) => {
    const e = current(r);
    if (filter === 'all') return true;
    if (filter === 'noResult') return r.noResult;
    if (filter === 'noSection') return e.decision !== 'LEAVE' && !e.targetSectionId;
    return e.decision === filter;
  });

  if (run.isPending) return <Skeleton className="h-96 rounded-xl" />;
  if (run.isError || !data)
    return (
      <Alert variant="destructive">
        <AlertDescription>{String(run.error)}</AlertDescription>
      </Alert>
    );

  const editable = runEditable(data);
  const sectionLabel = label('section', 'Section');
  const sectionText = label('section', 'Section', { inText: true });
  const activeClasses = (classes.data ?? [])
    .filter((c) => c.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const sectionsOf = (classLevelId: string | null) =>
    (sections.data ?? []).filter((s) => s.isActive && s.classLevelId === classLevelId);
  const change = (r: PromotionRowView, patch: Partial<Edit>) =>
    setEdits((all) => {
      const next = { ...current(r), ...patch };
      return { ...all, [r.id]: next };
    });
  /** A decision with its natural target: the next class, the same class, or leaving. */
  const decide = (r: PromotionRowView, decision: PromotionDecision, status?: LeaveStatus) => {
    if (decision === 'LEAVE')
      return change(r, {
        decision,
        targetClassLevelId: null,
        targetSectionId: null,
        targetStudyGroupId: null,
        leaveStatus: status ?? current(r).leaveStatus ?? 'GRADUATED',
        // The old year's last day unless a date was already chosen (review NIT 2).
        leftOn: current(r).leftOn ?? data.fromYear.endDate,
      });
    const target =
      decision === 'REPEAT' ? data.classLevel.id : (data.nextClassLevel?.id ?? data.classLevel.id);
    const sameName = sectionsOf(target).find((s) => s.name === r.fromSection?.name);
    change(r, {
      decision,
      targetClassLevelId: target,
      targetSectionId: sameName?.id ?? null,
      leaveStatus: null,
      leftOn: null,
      leaveReason: null,
    });
  };
  const bulk = (decision: PromotionDecision) => {
    for (const r of rows.filter((x) => selected.has(x.id) && !x.appliedAt)) decide(r, decision);
    setSelected(new Set());
  };
  const changed = Object.keys(edits).length;
  const applied = rows.filter((r) => r.appliedAt).length;

  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="promotion-run">
      <ConfirmDialog
        open={deleting}
        onOpenChange={(o) => !o && setDeleting(false)}
        title={t('deleteTitle')}
        body={t('deleteBody')}
        confirmLabel={t('delete')}
        pending={remove.isPending}
        onConfirm={() => remove.mutate(undefined)}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <ButtonLink variant="ghost" size="sm" href="/setup/new-year" className="self-start">
            <ArrowLeftIcon aria-hidden />
            {t('back')}
          </ButtonLink>
          <h1 className="text-2xl font-semibold">
            {t('title', {
              classLevel: pick(locale, data.classLevel),
              from: data.fromYear.name,
              to: data.toYear.name,
            })}
          </h1>
          <p className="text-muted-foreground text-sm">
            {data.meritExam
              ? t('meritExam', { name: pick(locale, data.meritExam) })
              : t('noMeritExam')}
          </p>
        </div>
        <SelectField
          id="run-strategy"
          label={t('strategy')}
          value={data.rollStrategy}
          onChange={(v) => strategy.mutate(v as RollStrategy)}
          options={ROLL_STRATEGIES.filter((s) => s !== 'MERIT' || data.meritExam).map((s) => ({
            value: s,
            label: t(`strategies.${s}`),
          }))}
        />
      </div>

      <SectionCard
        id="run-rows"
        title={t('decision')}
        actions={
          editable && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refresh.mutate(undefined)}
                disabled={refresh.isPending || changed > 0}
              >
                <RefreshCwIcon aria-hidden />
                {t('refresh')}
              </Button>
              {applied === 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleting(true)}
                  data-testid="delete-run"
                >
                  <Trash2Icon aria-hidden />
                  {t('delete')}
                </Button>
              )}
            </>
          )
        }
      >
        <div className="flex flex-wrap items-end gap-3">
          <SelectField
            id="run-filter"
            label={t('filter')}
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
            options={(['all', 'PROMOTE', 'REPEAT', 'LEAVE', 'noResult', 'noSection'] as const).map(
              (k) => ({ value: k, label: t(`filters.${k}`, { section: sectionText }) }),
            )}
          />
          {editable && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  rows
                    .filter((r) => !r.appliedAt && r.resultPassed === true)
                    .forEach((r) => decide(r, 'PROMOTE'))
                }
                data-testid="all-passed-promote"
              >
                {t('allPassedPromote')}
              </Button>
              {selected.size > 0 && (
                <>
                  <span className="text-muted-foreground self-center text-sm">
                    {t('selected', { count: f(selected.size) })}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => bulk('PROMOTE')}>
                    {t('bulkPromote')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => bulk('REPEAT')}>
                    {t('bulkRepeat')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => bulk('LEAVE')}>
                    {t('bulkLeave')}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        <ul className="flex flex-col divide-y rounded-lg border" data-testid="run-rows-list">
          {shown.map((r) => {
            const e = current(r);
            const name =
              pick(locale, { nameBn: r.student.nameBn ?? '', nameEn: r.student.nameEn ?? '' }) ||
              formatIdentifier(r.student.studentCode);
            const locked = !editable || r.appliedAt !== null;
            return (
              <li
                key={r.id}
                data-testid="run-row"
                data-row-id={r.id}
                className={cn(
                  'flex flex-col gap-2 px-3 py-3 md:flex-row md:flex-wrap md:items-end',
                  invalid.has(r.id) && 'bg-destructive/5',
                  edits[r.id] && 'bg-accent/40',
                )}
              >
                <div className="flex min-w-0 items-start gap-3 md:w-64">
                  {!locked && (
                    <input
                      type="checkbox"
                      className="mt-1 size-4"
                      aria-label={t('select', { name })}
                      checked={selected.has(r.id)}
                      onChange={(ev) =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (ev.target.checked) n.add(r.id);
                          else n.delete(r.id);
                          return n;
                        })
                      }
                    />
                  )}
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium break-words">{name}</span>
                    <span className="text-muted-foreground text-xs">
                      <span dir="ltr" className="tabular-nums">
                        {formatIdentifier(r.student.studentCode)}
                      </span>
                      {' · '}
                      {t('from')}: {r.fromSection?.name ?? '—'}
                      {r.fromRoll !== null && (
                        <>
                          {' · '}
                          {label('roll', 'Roll')}{' '}
                          <span dir="ltr" className="tabular-nums">
                            {r.fromRoll}
                          </span>
                        </>
                      )}
                    </span>
                    <span className="mt-1">
                      {r.noResult ? (
                        <Pill tone="neutral">{t('noResult')}</Pill>
                      ) : r.resultPassed ? (
                        <Pill tone="success">
                          {t('passed')}
                          {r.meritPosition !== null &&
                            ` · ${t('place', { place: f(r.meritPosition) })}`}
                        </Pill>
                      ) : (
                        <Pill tone="destructive">{t('failed')}</Pill>
                      )}
                    </span>
                  </div>
                </div>
                {locked ? (
                  <div className="text-sm md:flex-1">
                    <Pill tone="neutral">{t(`decisions.${e.decision}`)}</Pill>{' '}
                    {r.applyOutcome && (
                      <span className="text-muted-foreground">
                        {t(`outcomes.${r.applyOutcome}`)}
                      </span>
                    )}
                  </div>
                ) : (
                  <>
                    <SelectField
                      id={`decision-${r.id}`}
                      label={t('decision')}
                      value={e.decision}
                      onChange={(v) => decide(r, v as PromotionDecision)}
                      options={(['PROMOTE', 'REPEAT', 'LEAVE'] as const).map((d) => ({
                        value: d,
                        label: t(`decisions.${d}`),
                      }))}
                    />
                    {e.decision === 'LEAVE' ? (
                      <>
                        <SelectField
                          id={`leave-${r.id}`}
                          label={t('leaveStatus')}
                          value={e.leaveStatus ?? 'GRADUATED'}
                          onChange={(v) => change(r, { leaveStatus: v as LeaveStatus })}
                          options={LEAVE_STATUSES.map((s) => ({
                            value: s,
                            label: tStatus(s),
                          }))}
                        />
                        <div className="flex flex-col gap-1.5">
                          <label htmlFor={`left-${r.id}`} className="text-sm font-medium">
                            {t('leftOn')}
                          </label>
                          <DateInput
                            id={`left-${r.id}`}
                            value={e.leftOn ?? ''}
                            onValueChange={(v) => change(r, { leftOn: v || null })}
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <SelectField
                          id={`target-class-${r.id}`}
                          label={t('targetClass')}
                          value={e.targetClassLevelId ?? ''}
                          onChange={(v) =>
                            change(r, { targetClassLevelId: v, targetSectionId: null })
                          }
                          options={activeClasses.map((c) => ({
                            value: c.id,
                            label: pick(locale, c),
                          }))}
                        />
                        <SelectField
                          id={`target-section-${r.id}`}
                          label={t('targetSection', { section: sectionLabel })}
                          value={e.targetSectionId ?? ''}
                          onChange={(v) => change(r, { targetSectionId: v || null })}
                          placeholder={t('noSection')}
                          options={sectionsOf(e.targetClassLevelId).map((s) => ({
                            value: s.id,
                            label: s.name,
                          }))}
                        />
                      </>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {editable && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => save.mutate(undefined)}
              disabled={changed === 0 || save.isPending}
              data-testid="save-rows"
            >
              <SaveIcon aria-hidden />
              {t('save')}
            </Button>
            {changed > 0 && (
              <span className="text-muted-foreground text-sm">
                {t('unsaved', { count: f(changed) })}
              </span>
            )}
          </div>
        )}
      </SectionCard>

      <SectionCard id="run-apply" title={t('applyTitle')} hint={t('applyHint')}>
        {data.status === 'APPLYING' ? (
          <div className="flex flex-col gap-3" data-testid="run-applying">
            <p className="text-sm">{t('applying', { done: f(applied), total: f(rows.length) })}</p>
            {data.lastError && (
              <Alert variant="destructive">
                <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                  {t('stopped', { reason: stopReason(data.lastError) })}
                  <Button
                    size="sm"
                    onClick={() => resume.mutate(undefined)}
                    disabled={resume.isPending}
                  >
                    <RotateCcwIcon aria-hidden />
                    {t('resume')}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
          </div>
        ) : data.counts.pending === 0 ? (
          <p className="text-sm" data-testid="run-applied">
            <Pill tone="success">{t('appliedAll')}</Pill>
          </p>
        ) : !check.data ? (
          <Skeleton className="h-20" />
        ) : (
          <div className="flex flex-col gap-3" data-testid="apply-check">
            <p className="text-sm">
              {t('pending', {
                promote: f(check.data.pending.promote),
                repeat: f(check.data.pending.repeat),
                leave: f(check.data.pending.leave),
              })}
            </p>
            <ul className="flex flex-col gap-1 text-sm">
              {check.data.sections.map((s) => (
                <li key={s.section.id} className={cn(s.full && 'text-destructive font-medium')}>
                  {pick(locale, s.classLevel)} ·{' '}
                  {s.capacity === null
                    ? t('capacityOpen', {
                        section: sectionLabel,
                        name: s.section.name,
                        enrolled: f(s.enrolled),
                        incoming: f(s.incoming),
                      })
                    : t('capacity', {
                        section: sectionLabel,
                        name: s.section.name,
                        enrolled: f(s.enrolled),
                        incoming: f(s.incoming),
                        capacity: f(s.capacity),
                      })}
                </li>
              ))}
            </ul>
            {check.data.withoutSection > 0 && (
              <p className="text-muted-foreground text-sm">
                {t('withoutSection', { count: f(check.data.withoutSection), section: sectionText })}
              </p>
            )}
            {changed > 0 && <p className="text-sm">{t('saveFirst')}</p>}
            <div>
              {/* Not while the check reloads: a save changes the check's version (its rows'
                  updatedAt) but often not the pending count in its key, so until the reload
                  lands the version here is the old one and apply would get PREVIEW_CHANGED. */}
              <Button
                onClick={() => apply.mutate(undefined)}
                disabled={apply.isPending || changed > 0 || check.isFetching}
                data-testid="apply-run"
              >
                <PlayIcon aria-hidden />
                {t('apply')}
              </Button>
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

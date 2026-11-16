'use client';

import { useQuery } from '@tanstack/react-query';
import {
  formatCount,
  toAsciiDigits,
  type FeeCopyResult,
  type PromotionRunDetail,
  type PromotionRunsOverview,
  type RollsPreview,
  type SetupAcademicYear,
  type SetupClassLevel,
  type SwitchCheck,
  type TeacherCopyResult,
} from '@jantrik/shared';
import { CalendarPlusIcon, CheckCircle2Icon, CopyIcon, PlayIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { SectionCard, SelectField, TextField, ToggleField } from '@/components/form-kit';
import { Pill } from '@/components/kit/pill';
import { PageGate } from '@/components/page-gate';
import { pick, usePromotionMutation } from '@/components/promotion/kit';
import { useSetupQuery } from '@/components/setup/setup-kit';
import { YearDialog } from '@/components/setup/year-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useLabel, useMeContext } from '@/lib/hooks';

/**
 * The new academic year, step by step (P5, docs/promotion.md): the year, fee and teacher copies,
 * a promotion run per class, the rolls, then the switch after a check. Nothing happens by itself.
 */
export default function NewYearPage() {
  return (
    <PageGate page="setup">
      <Wizard />
    </PageGate>
  );
}

function Wizard() {
  const t = useTranslations('promotion.wizard');
  const label = useLabel();
  const { data: context } = useMeContext();
  const years = useSetupQuery<SetupAcademicYear[]>('/setup/academic-years');
  const [creating, setCreating] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const yearText = label('academic_year', 'Academic Year', { inText: true });

  if (years.isPending) return <Skeleton className="h-96 rounded-xl" />;
  const list = years.data ?? [];
  const current = list.find((y) => y.isCurrent) ?? null;
  const later = list
    .filter((y) => current && y.startDate > current.startDate)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const target = later.find((y) => y.id === chosen) ?? later[0] ?? null;
  // Copies come from the year just before the new one (the API refuses any other).
  const source = target
    ? (list
        .filter((y) => y.startDate < target.startDate)
        .sort((a, b) => b.startDate.localeCompare(a.startDate))[0] ?? null)
    : null;
  const fees = context?.modules.includes('FEES') ?? false;

  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="new-year">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('intro', { year: yearText })}</p>
      </div>

      <SectionCard
        id="new-year-year"
        title={t('yearTitle', { year: yearText })}
        hint={t('yearHint')}
        actions={
          current && (
            <Button
              variant="outline"
              onClick={() => setCreating(true)}
              data-testid="create-next-year"
            >
              <CalendarPlusIcon aria-hidden />
              {t('createNext', { year: yearText })}
            </Button>
          )
        }
      >
        {!current ? (
          <p className="text-muted-foreground text-sm">{t('noCurrent', { year: yearText })}</p>
        ) : later.length > 0 ? (
          <SelectField
            id="new-year-target"
            label={t('chooseYear', { year: yearText })}
            value={target?.id ?? ''}
            onChange={setChosen}
            options={later.map((y) => ({ value: y.id, label: y.name }))}
          />
        ) : null}
      </SectionCard>
      {creating && current && (
        <YearDialog year={null} from={current} onClose={() => setCreating(false)} />
      )}

      {current && target && (
        <>
          {fees && source && <FeesStep from={source} to={target} />}
          {source && <TeachersStep from={source} to={target} />}
          <PromoteStep to={target} />
          <RollsStep to={target} />
          <SwitchStep to={target} />
        </>
      )}
    </div>
  );
}

function CopyResultLine({ text }: { text: string | null }) {
  return text ? (
    <p className="text-muted-foreground text-sm" role="status">
      <CheckCircle2Icon aria-hidden className="text-success me-1 inline size-4" />
      {text}
    </p>
  ) : null;
}

type FeeCopyKey = 'amounts' | 'terms' | 'concessions';

/** One fee copy (POST /fees/<key>/copy) and the sentence saying what it did. */
function useFeeCopy(key: FeeCopyKey, from: SetupAcademicYear, to: SetupAcademicYear) {
  const t = useTranslations('promotion.wizard');
  const locale = useLocale() as Locale;
  const { client } = useAuth();
  const f = (n: number) => formatCount(n, locale);
  const body = { fromAcademicYearId: from.id, toAcademicYearId: to.id };
  const [done, setDone] = useState<string | null>(null);
  const mutation = usePromotionMutation(
    () => client.api<FeeCopyResult>(`/fees/${key}/copy`, { method: 'POST', json: body }),
    {
      onSuccess: (r) =>
        setDone(
          key === 'amounts'
            ? t('copiedAmounts', { copied: f(r.copied) })
            : [
                t('copied', { copied: f(r.copied), skipped: f(r.skipped) }),
                r.outsideYear
                  ? t('outsideYear', { count: f(r.outsideYear), n: r.outsideYear })
                  : '',
              ]
                .filter(Boolean)
                .join(' '),
        ),
    },
  );
  return { mutation, done };
}

function FeesStep({ from, to }: { from: SetupAcademicYear; to: SetupAcademicYear }) {
  const t = useTranslations('promotion.wizard');
  const amounts = useFeeCopy('amounts', from, to);
  const terms = useFeeCopy('terms', from, to);
  const concessions = useFeeCopy('concessions', from, to);
  return (
    <SectionCard id="new-year-fees" title={t('feesTitle')} hint={t('feesHint')}>
      <div className="flex flex-col gap-3">
        {(
          [
            ['amounts', amounts, t('copyAmounts')],
            ['terms', terms, t('copyTerms')],
            ['concessions', concessions, t('copyConcessions')],
          ] as const
        ).map(([key, copy, text]) => (
          <div key={key} className="flex flex-col gap-1">
            <div>
              <Button
                variant="outline"
                onClick={() => copy.mutation.mutate(undefined)}
                disabled={copy.mutation.isPending}
                data-testid={`copy-${key}`}
              >
                <CopyIcon aria-hidden />
                {text}
              </Button>
            </div>
            {key === 'concessions' && !copy.done && (
              <p className="text-muted-foreground text-sm">{t('copyConcessionsHint')}</p>
            )}
            <CopyResultLine text={copy.done} />
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function TeachersStep({ from, to }: { from: SetupAcademicYear; to: SetupAcademicYear }) {
  const t = useTranslations('promotion.wizard');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const { client } = useAuth();
  const f = (n: number) => formatCount(n, locale);
  const [sectionTeachers, setSectionTeachers] = useState(true);
  const [subjectTeachers, setSubjectTeachers] = useState(true);
  const [done, setDone] = useState<string | null>(null);
  const section = label('section', 'Section', { inText: true });
  const copy = usePromotionMutation(
    () =>
      client.api<TeacherCopyResult>(`/setup/academic-years/${to.id}/copy-teachers`, {
        method: 'POST',
        json: { fromAcademicYearId: from.id, classTeachers: sectionTeachers, subjectTeachers },
      }),
    {
      onSuccess: (r) =>
        setDone(
          t('teachersCopied', {
            sections: f(r.sectionTeachers),
            subjects: f(r.subjectTeachers),
            skipped: f(r.skipped),
            section,
          }),
        ),
    },
  );
  return (
    <SectionCard
      id="new-year-teachers"
      title={t('teachersTitle')}
      hint={t('teachersHint', { section })}
    >
      <div className="flex flex-col gap-3">
        <ToggleField
          id="copy-section-teachers"
          checked={sectionTeachers}
          onChange={setSectionTeachers}
          label={t('copySectionTeachers', { section })}
        />
        <ToggleField
          id="copy-subject-teachers"
          checked={subjectTeachers}
          onChange={setSubjectTeachers}
          label={t('copySubjectTeachers')}
        />
        <div>
          <Button
            variant="outline"
            onClick={() => copy.mutate(undefined)}
            disabled={copy.isPending || (!sectionTeachers && !subjectTeachers)}
            data-testid="copy-teachers"
          >
            <CopyIcon aria-hidden />
            {t('copyTeachers')}
          </Button>
        </div>
        <CopyResultLine text={done} />
      </div>
    </SectionCard>
  );
}

function PromoteStep({ to }: { to: SetupAcademicYear }) {
  const t = useTranslations('promotion.wizard');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { client, session } = useAuth();
  const f = (n: number) => formatCount(n, locale);
  const overview = useQuery({
    queryKey: ['promotion', session?.tenant?.id, 'overview', to.id],
    queryFn: () => client.api<PromotionRunsOverview>(`/promotions?toYearId=${to.id}`),
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => r.status === 'APPLYING') ? 3_000 : false,
  });
  const start = usePromotionMutation(
    (classLevelId: string) =>
      client.api<PromotionRunDetail>('/promotions', {
        method: 'POST',
        json: { fromYearId: overview.data!.fromYear!.id, toYearId: to.id, classLevelId },
      }),
    { onSuccess: (run) => router.push(`/setup/new-year/${run.id}`) },
  );
  const data = overview.data;
  return (
    <SectionCard id="new-year-promote" title={t('promoteTitle')} hint={t('promoteHint')}>
      {!data ? (
        <Skeleton className="h-32" />
      ) : data.runs.length === 0 && data.classesWithoutRun.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('noRuns')}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border" data-testid="promotion-classes">
          {data.runs.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{pick(locale, r.classLevel)}</span>
                  <Pill
                    tone={
                      r.status === 'APPLIED'
                        ? 'success'
                        : r.status === 'APPLYING'
                          ? 'info'
                          : 'neutral'
                    }
                  >
                    {t(`status.${r.status}`)}
                  </Pill>
                </span>
                <span className="text-muted-foreground text-sm">
                  {t('runCounts', {
                    promote: f(r.counts.promote),
                    repeat: f(r.counts.repeat),
                    leave: f(r.counts.leave),
                  })}
                  {r.counts.pending > 0 && r.status !== 'DRAFT'
                    ? ` · ${t('pendingCount', { count: f(r.counts.pending) })}`
                    : ''}
                </span>
              </span>
              <ButtonLink size="sm" variant="outline" href={`/setup/new-year/${r.id}`}>
                {t('openRun')}
              </ButtonLink>
            </li>
          ))}
          {data.classesWithoutRun.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-semibold">{pick(locale, c)}</span>
                <span className="text-muted-foreground text-sm">
                  {t('studentsCount', { count: f(c.students), n: c.students })}
                </span>
              </span>
              <Button
                size="sm"
                onClick={() => start.mutate(c.id)}
                disabled={start.isPending || !data.fromYear}
                data-testid={`start-run-${c.id}`}
              >
                <PlayIcon aria-hidden />
                {t('startRun')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function RollsStep({ to }: { to: SetupAcademicYear }) {
  const t = useTranslations('promotion.wizard');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const { client, session } = useAuth();
  const classes = useSetupQuery<SetupClassLevel[]>('/setup/class-levels');
  const [classLevelId, setClassLevelId] = useState('');
  const preview = useQuery({
    queryKey: ['promotion', session?.tenant?.id, 'rolls', to.id, classLevelId],
    queryFn: () =>
      client.api<RollsPreview>(`/promotions/rolls?toYearId=${to.id}&classLevelId=${classLevelId}`),
    enabled: classLevelId !== '',
  });
  // What the admin typed, for the preview version it was typed against (a new version starts
  // from the proposal again).
  const [typedFor, setTypedFor] = useState<{ version?: string; values: Record<string, string> }>({
    values: {},
  });
  const typed = typedFor.version === preview.data?.version ? typedFor.values : {};
  const setTyped = (update: (values: Record<string, string>) => Record<string, string>) =>
    setTypedFor({ version: preview.data?.version, values: update(typed) });
  const [force, setForce] = useState(false);
  const save = usePromotionMutation(
    () => {
      const p = preview.data!;
      return client.api<RollsPreview>('/promotions/rolls', {
        method: 'PUT',
        json: {
          toYearId: to.id,
          classLevelId,
          version: p.version,
          sections: p.sections
            .map((s) => ({
              sectionId: s.section.id,
              rolls: s.rows
                .filter((r) => r.roll === null)
                .map((r) => ({
                  enrolmentId: r.enrolmentId,
                  roll: toAsciiDigits(typed[r.enrolmentId] ?? String(r.proposed ?? '')).trim(),
                }))
                .filter((r) => r.roll !== ''),
            }))
            .filter((s) => s.rolls.length > 0),
          force,
        },
      });
    },
    { success: t('rollsSaved') },
  );
  const classLabel = label('class_level', 'Class', { inText: true });
  const section = label('section', 'Section', { inText: true });
  const p = preview.data;
  const waiting = p?.sections.some((s) => s.rows.some((r) => r.roll === null)) ?? false;
  return (
    <SectionCard id="new-year-rolls" title={t('rollsTitle')} hint={t('rollsHint')}>
      <SelectField
        id="rolls-class"
        label={label('class_level', 'Class')}
        value={classLevelId}
        onChange={(v) => {
          setClassLevelId(v);
          setForce(false); // "number anyway" is asked again for each class
        }}
        placeholder={t('rollsChoose', { classLevel: classLabel })}
        options={(classes.data ?? [])
          .filter((c) => c.isActive)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((c) => ({ value: c.id, label: pick(locale, c) }))}
      />
      {classLevelId && !p && <Skeleton className="h-24" />}
      {p && !waiting && (
        <p className="text-muted-foreground text-sm">
          {t('rollsNone', { classLevel: classLabel })}
        </p>
      )}
      {p && p.pendingRuns.length > 0 && waiting && (
        <Alert data-testid="rolls-pending-runs">
          <AlertDescription className="flex flex-col gap-2">
            <span>
              {t('rollsPendingRuns', {
                names: p.pendingRuns.map((r) => pick(locale, r.classLevel)).join(', '),
                count: formatCount(
                  p.pendingRuns.reduce((sum, r) => sum + r.pending, 0),
                  locale,
                ),
              })}
            </span>
            <ToggleField
              id="rolls-force"
              checked={force}
              onChange={setForce}
              label={t('rollsForce')}
            />
          </AlertDescription>
        </Alert>
      )}
      {p && p.withoutSection > 0 && (
        <Alert>
          <AlertDescription>
            {t('rollsWithoutSection', { count: formatCount(p.withoutSection, locale), section })}
          </AlertDescription>
        </Alert>
      )}
      {p && p.sections.length > 0 && (
        <div className="flex flex-col gap-4" data-testid="rolls-preview">
          {p.sections.map((s) => (
            <div key={s.section.id} className="flex flex-col gap-2">
              <h3 className="font-semibold">{s.section.name}</h3>
              <ul className="flex flex-col divide-y rounded-lg border">
                {s.rows.map((r) => (
                  <li
                    key={r.enrolmentId}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                    data-testid="rolls-row"
                  >
                    <span className="min-w-0 flex-1">
                      {pick(locale, {
                        nameBn: r.nameBn ?? r.nameEn ?? '',
                        nameEn: r.nameEn ?? r.nameBn ?? '',
                      })}
                      <span className="text-muted-foreground ms-2 text-sm">
                        {t(`rollsGroup.${r.group}`)}
                      </span>
                    </span>
                    {r.roll !== null ? (
                      <span className="text-muted-foreground text-sm tabular-nums" dir="ltr">
                        {r.roll} · {t('rollsKept')}
                      </span>
                    ) : (
                      <TextField
                        id={`roll-${r.enrolmentId}`}
                        label={label('roll', 'Roll')}
                        value={typed[r.enrolmentId] ?? String(r.proposed ?? '')}
                        onChange={(v) => setTyped((x) => ({ ...x, [r.enrolmentId]: v }))}
                        inputMode="numeric"
                        dir="ltr"
                        maxLength={6}
                        className="w-28"
                      />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {waiting && (
            <div>
              <Button
                onClick={() => save.mutate(undefined)}
                disabled={save.isPending || (p.pendingRuns.length > 0 && !force)}
                data-testid="save-rolls"
              >
                {t('rollsSave')}
              </Button>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function SwitchStep({ to }: { to: SetupAcademicYear }) {
  const t = useTranslations('promotion.wizard');
  const locale = useLocale() as Locale;
  const label = useLabel();
  const { client, session } = useAuth();
  const f = (n: number) => formatCount(n, locale);
  const check = useQuery({
    queryKey: ['promotion', session?.tenant?.id, 'switch', to.id],
    queryFn: () => client.api<SwitchCheck>(`/promotions/switch-check?toYearId=${to.id}`),
  });
  const [understood, setUnderstood] = useState(false);
  const doSwitch = usePromotionMutation(
    () => client.api(`/setup/academic-years/${to.id}/current`, { method: 'POST' }),
    { success: t('switchDone', { name: to.name }) },
  );
  const c = check.data;
  const names = (list: { nameBn: string; nameEn: string }[]) =>
    list.map((x) => pick(locale, x)).join(', ');
  const lines = c
    ? [
        c.classesWithoutRun.length > 0 &&
          t('switchClassesWithoutRun', { names: names(c.classesWithoutRun) }),
        c.runsNotApplied.length > 0 &&
          t('switchRunsNotApplied', { names: names(c.runsNotApplied.map((r) => r.classLevel)) }),
        c.classesWithoutPublishedAnnual.length > 0 &&
          t('switchUnpublished', { names: names(c.classesWithoutPublishedAnnual) }),
        c.notCarriedOver > 0 &&
          t('switchNotCarriedOver', { count: f(c.notCarriedOver), n: c.notCarriedOver }),
        c.withoutRoll > 0 && t('switchWithoutRoll', { count: f(c.withoutRoll), n: c.withoutRoll }),
        c.withoutSection > 0 &&
          t('switchWithoutSection', {
            count: f(c.withoutSection),
            n: c.withoutSection,
            section: label('section', 'Section', { inText: true }),
          }),
      ].filter((x): x is string => Boolean(x))
    : [];
  return (
    <SectionCard id="new-year-switch" title={t('switchTitle')} hint={t('switchHint')}>
      {!c ? (
        <Skeleton className="h-24" />
      ) : c.toYear.isCurrent ? (
        <p className="text-sm">{t('alreadyCurrent', { name: to.name })}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {lines.length === 0 ? (
            <p className="text-sm" data-testid="switch-clean">
              {t('switchClean')}
            </p>
          ) : (
            <ul
              className="flex list-disc flex-col gap-1 ps-5 text-sm"
              data-testid="switch-warnings"
            >
              {lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
          {!c.clean && (
            <ToggleField
              id="switch-understand"
              checked={understood}
              onChange={setUnderstood}
              label={t('switchUnderstand')}
            />
          )}
          <div>
            <Button
              onClick={() => doSwitch.mutate(undefined)}
              disabled={doSwitch.isPending || (!c.clean && !understood)}
              data-testid="switch-year"
            >
              {t('switchDo', { name: to.name })}
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

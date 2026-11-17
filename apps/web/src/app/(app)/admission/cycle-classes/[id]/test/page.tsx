'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatCount,
  formatDate,
  formatIdentifier,
  formatMarks,
  formatTaka,
  formatTime,
  formatWallClock,
  toAsciiDigits,
  type AdmissionAdmitCard,
  type AdmissionAdmitCards,
  type AdmissionMeritView,
  type AdmissionMoveUpResult,
  type AdmissionResultSmsPreview,
  type AdmissionResultSmsRun,
  type AdmissionScoreRow,
  type AdmissionTestClassView,
} from '@jantrik/shared';
import { cn } from 'cn';
import { ChevronLeftIcon, PrinterIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { APPLICATION_TONE, errorCode } from '@/components/admission/admission-kit';
import { SectionCard, TextField } from '@/components/form-kit';
import { ActionBar, FormGrid } from '@/components/form-layout';
import { Pill } from '@/components/kit/pill';
import { PageGate } from '@/components/page-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Locale } from '@/i18n/config';
import { useAuthedImage } from '@/lib/authed-image';
import { useAuth } from '@/lib/auth/auth-provider';
import { useErrorMessage } from '@/lib/hooks';
import { displayName } from '@/lib/names';

/**
 * A class's admission test (sprint 1 P4, OWNER/ADMIN): its settings and test rolls, the admit
 * cards (two to an A4), the scores, the merit list (build, publish) and the result SMS with the
 * waitlist move-up.
 */
export default function AdmissionTestPage() {
  return (
    <PageGate page="admission">
      <AdmissionTest />
    </PageGate>
  );
}

const TABS = ['setup', 'cards', 'scores', 'merit', 'sms'] as const;
type Tab = (typeof TABS)[number];

function useTest() {
  const { client, session } = useAuth();
  const { id } = useParams<{ id: string }>();
  const key = ['admission-test', session?.tenant?.id, id];
  const query = useQuery({
    queryKey: key,
    queryFn: () => client.api<AdmissionTestClassView>(`/admission/cycle-classes/${id}/test`),
  });
  return { id, client, key, query };
}

function AdmissionTest() {
  const t = useTranslations('admissions.staff.test');
  const locale = useLocale() as Locale;
  const { query } = useTest();
  const [tab, setTab] = useState<Tab>('setup');
  if (query.isPending) return <Skeleton className="h-96 rounded-xl" />;
  const v = query.data;
  if (!v) return null;
  return (
    <div className="flex flex-col gap-(--section-gap)" data-testid="admission-test">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <Link
          href={`/admission/cycles/${v.cycle.id}`}
          className="text-muted-foreground hover:text-foreground inline-flex min-h-(--control-h) items-center gap-1 text-sm"
        >
          <ChevronLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
          {t('back')}
        </Link>
        <h2 className="text-lg font-semibold">
          {t('title')} · {displayName(v.classLevel.nameBn, v.classLevel.nameEn, locale)}
          {v.studyGroup && ` · ${displayName(v.studyGroup.nameBn, v.studyGroup.nameEn, locale)}`}
        </h2>
        <span className="text-muted-foreground text-sm">
          {displayName(v.cycle.nameBn, v.cycle.nameEn, locale)}
        </span>
      </div>
      {!v.cycle.requiresTest ? (
        <Alert>
          <AlertDescription>{t('notRequired')}</AlertDescription>
        </Alert>
      ) : (
        <Tabs value={tab} onValueChange={(x: Tab) => setTab(x)} className="gap-(--section-gap)">
          <TabsList aria-label={t('tabsLabel')} className="max-w-full overflow-x-auto print:hidden">
            {TABS.map((k) => (
              <TabsTrigger key={k} value={k} data-testid={`test-tab-${k}`}>
                {t(`tabs.${k}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="setup" className="text-base">
            <SetupTab view={v} />
          </TabsContent>
          <TabsContent value="cards" className="text-base">
            <CardsTab />
          </TabsContent>
          <TabsContent value="scores" className="text-base">
            <ScoresTab view={v} />
          </TabsContent>
          <TabsContent value="merit" className="text-base">
            <MeritTab view={v} />
          </TabsContent>
          <TabsContent value="sms" className="text-base">
            <SmsTab view={v} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

// ─────────────────────────── Setup and rolls ───────────────────────────

function SetupTab({ view }: { view: AdmissionTestClassView }) {
  const t = useTranslations('admissions.staff.test');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const { id, client, key } = useTest();
  const initial = () => ({
    testDate: view.testDate ?? '',
    testTime: view.testTime ?? '',
    testVenueBn: view.testVenueBn ?? '',
    testVenueEn: view.testVenueEn ?? '',
    fullMarks: view.fullMarks != null ? String(view.fullMarks) : '',
    passMarks: view.passMarks != null ? String(view.passMarks) : '',
    selectCount: view.selectCount != null ? String(view.selectCount) : '',
    waitlistCount: view.waitlistCount != null ? String(view.waitlistCount) : '',
  });
  const [form, setForm] = useState(initial);
  const [source, setSource] = useState(view);
  if (view !== source) {
    setSource(view);
    setForm(initial());
  }
  const [startAt, setStartAt] = useState('1');
  const set = (k: keyof typeof form) => (value: string) => setForm({ ...form, [k]: value });
  const save = useMutation({
    mutationFn: () =>
      client.api<AdmissionTestClassView>(`/admission/cycle-classes/${id}/test`, {
        method: 'PATCH',
        json: {
          testDate: form.testDate || null,
          testTime: form.testTime || null,
          testVenueBn: form.testVenueBn,
          testVenueEn: form.testVenueEn,
          fullMarks: form.fullMarks,
          passMarks: form.passMarks,
          selectCount: form.selectCount,
          waitlistCount: form.waitlistCount,
        },
      }),
    onSuccess: (v) => {
      queryClient.setQueryData(key, v);
      toast.success(t('saved'));
    },
    onError: (e) => {
      const code = errorCode(e);
      if (code === 'PASS_ABOVE_FULL') toast.error(t('passAboveFull'));
      else if (code === 'SCORES_ABOVE_FULL') toast.error(t('scoresAboveFull'));
      else toast.error(describe(e));
    },
  });
  const rolls = useMutation({
    mutationFn: () =>
      client.api<{ issued: number }>(`/admission/cycle-classes/${id}/test-rolls`, {
        method: 'POST',
        json: { startAt: toAsciiDigits(startAt.trim()) || null },
      }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: key });
      toast.success(
        r.issued > 0 ? t('issued', { count: formatCount(r.issued, locale) }) : t('noneToIssue'),
      );
    },
    onError: (e) => toast.error(describe(e)),
  });
  return (
    <div className="flex flex-col gap-(--section-gap)">
      <form
        noValidate
        className="flex flex-col gap-(--section-gap)"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <SectionCard id="test-setup" title={t('setup')} hint={t('setupHint')}>
          <FormGrid>
            <TextField
              id="testDate"
              type="date"
              label={t('date')}
              value={form.testDate}
              onChange={set('testDate')}
            />
            <TextField
              id="testTime"
              type="time"
              label={t('time')}
              value={form.testTime}
              onChange={set('testTime')}
            />
            <TextField
              id="testVenueBn"
              label={t('venueBn')}
              value={form.testVenueBn}
              onChange={set('testVenueBn')}
              maxLength={200}
            />
            <TextField
              id="testVenueEn"
              label={t('venueEn')}
              value={form.testVenueEn}
              onChange={set('testVenueEn')}
              maxLength={200}
            />
            <TextField
              id="fullMarks"
              label={t('fullMarks')}
              value={form.fullMarks}
              onChange={set('fullMarks')}
              inputMode="numeric"
            />
            <TextField
              id="passMarks"
              label={t('passMarks')}
              hint={t('passHint')}
              value={form.passMarks}
              onChange={set('passMarks')}
              inputMode="numeric"
            />
            <TextField
              id="selectCount"
              label={t('selectCount')}
              value={form.selectCount}
              onChange={set('selectCount')}
              inputMode="numeric"
            />
            <TextField
              id="waitlistCount"
              label={t('waitlistCount')}
              value={form.waitlistCount}
              onChange={set('waitlistCount')}
              inputMode="numeric"
            />
          </FormGrid>
        </SectionCard>
        <ActionBar>
          <Button type="submit" disabled={save.isPending} data-testid="save-test">
            {t('save')}
          </Button>
        </ActionBar>
      </form>
      <SectionCard id="test-rolls" title={t('rolls')} hint={t('rollsHint')}>
        <p className="text-sm">
          {t('withRoll', { count: formatCount(view.counts.withRoll, locale) })} ·{' '}
          {t('awaitingRoll', { count: formatCount(view.counts.awaitingRoll, locale) })}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          {view.counts.withRoll === 0 && (
            <TextField
              id="startAt"
              label={t('startAt')}
              value={startAt}
              onChange={setStartAt}
              inputMode="numeric"
            />
          )}
          <Button
            onClick={() => rolls.mutate()}
            disabled={rolls.isPending || view.counts.awaitingRoll === 0}
            data-testid="issue-rolls"
          >
            {t('issue')}
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}

// ─────────────────────────── Admit cards ───────────────────────────

function CardsTab() {
  const t = useTranslations('admissions.staff.test');
  const describe = useErrorMessage();
  const { id, client } = useTest();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const cards = useQuery({
    queryKey: ['admission-admit-cards', id, range],
    queryFn: () => {
      const q = new URLSearchParams();
      if (range?.from) q.set('from', toAsciiDigits(range.from));
      if (range?.to) q.set('to', toAsciiDigits(range.to));
      return client.api<AdmissionAdmitCards>(`/admission/cycle-classes/${id}/admit-cards?${q}`);
    },
    enabled: range !== null,
    retry: false,
  });
  return (
    <div className="flex flex-col gap-(--section-gap)">
      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <TextField
          id="cards-from"
          label={t('from')}
          value={from}
          onChange={setFrom}
          inputMode="numeric"
        />
        <TextField id="cards-to" label={t('to')} value={to} onChange={setTo} inputMode="numeric" />
        <Button onClick={() => setRange({ from, to })} data-testid="show-cards">
          {t('showCards')}
        </Button>
        {cards.data && (
          <Button variant="outline" onClick={() => window.print()} data-testid="print-cards">
            <PrinterIcon aria-hidden />
            {t('print')}
          </Button>
        )}
      </div>
      {cards.error && (
        <Alert>
          <AlertDescription>
            {errorCode(cards.error) === 'ROLLS_NOT_ISSUED' ? t('noRolls') : describe(cards.error)}
          </AlertDescription>
        </Alert>
      )}
      {cards.data && <AdmitCardsPrint data={cards.data} />}
    </div>
  );
}

/** Two to an A4 sheet with a cut line, inside the exams' print area (`@page exam-a4`). */
function AdmitCardsPrint({ data }: { data: AdmissionAdmitCards }) {
  const pages: AdmissionAdmitCard[][] = [];
  for (let i = 0; i < data.cards.length; i += 2) pages.push(data.cards.slice(i, i + 2));
  return (
    <div className="exam-print print-area flex flex-col gap-6" data-testid="admission-admit-cards">
      {pages.map((pair, i) => (
        <div key={i} className="exam-page flex flex-col gap-6">
          {pair.map((c, j) => (
            <AdmitCard
              key={c.applicationId}
              data={data}
              card={c}
              cut={j === 0 && pair.length > 1}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function AdmitCard({
  data,
  card,
  cut,
}: {
  data: AdmissionAdmitCards;
  card: AdmissionAdmitCard;
  cut: boolean;
}) {
  const t = useTranslations('admissions.staff.test');
  const locale = useLocale() as Locale;
  const photo = useAuthedImage(
    card.hasPhoto ? `/admission/applications/${card.applicationId}/photo` : null,
    card.applicationId,
  );
  const logo = useAuthedImage(data.institute.hasLogo ? '/institute/profile/logo' : null, 'logo');
  const institute =
    (locale === 'bn' ? data.institute.nameBn : data.institute.nameEn) ?? data.institute.name;
  const venue =
    locale === 'bn'
      ? (data.testVenueBn ?? data.testVenueEn)
      : (data.testVenueEn ?? data.testVenueBn);
  return (
    <article
      className={cn(
        'bg-card mx-auto flex w-full max-w-[190mm] flex-col gap-3 rounded-xl border p-5 text-sm print:min-h-[128mm] print:rounded-none print:bg-white print:text-black',
        cut && 'print:border-b-2 print:border-dashed',
      )}
      data-testid="admission-admit-card"
    >
      <header className="flex items-center gap-3">
        {logo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt="" className="size-12 object-contain" />
        )}
        <div className="flex-1 text-center">
          <p className="text-base font-bold">{institute}</p>
          <p className="font-semibold">
            {displayName(data.cycle.nameBn, data.cycle.nameEn, locale)}
          </p>
          <p className="text-muted-foreground print:text-black">{t('cardTitle')}</p>
        </div>
      </header>
      <div className="flex gap-4">
        <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground print:text-black">{t('roll')}</dt>
          <dd className="font-mono text-2xl font-bold" data-testid="card-roll">
            {formatIdentifier(card.testRoll)}
          </dd>
          <dt className="text-muted-foreground print:text-black">{t('name')}</dt>
          <dd className="font-semibold">{displayName(card.nameBn, card.nameEn, locale)}</dd>
          <dt className="text-muted-foreground print:text-black">{t('applicationNo')}</dt>
          <dd className="font-mono">{formatIdentifier(card.applicationNo)}</dd>
          <dt className="text-muted-foreground print:text-black">{t('classLabel')}</dt>
          <dd>
            {displayName(data.classLevel.nameBn, data.classLevel.nameEn, locale)}
            {data.studyGroup &&
              ` · ${displayName(data.studyGroup.nameBn, data.studyGroup.nameEn, locale)}`}
          </dd>
          <dt className="text-muted-foreground print:text-black">{t('when')}</dt>
          <dd>
            {data.testDate ? formatDate(data.testDate, locale) : '—'}
            {data.testTime && `, ${formatWallClock(data.testTime, locale)}`}
          </dd>
          <dt className="text-muted-foreground print:text-black">{t('venue')}</dt>
          <dd>{venue ?? '—'}</dd>
        </dl>
        {photo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo}
            alt=""
            className="aspect-[3/4] w-24 self-start rounded border object-cover"
          />
        )}
      </div>
      <p className="text-xs">{t('bring')}</p>
      <footer className="mt-auto grid grid-cols-2 gap-6 pt-6 text-center text-xs">
        <p className="border-t pt-1">{t('applicantSignature')}</p>
        <p className="border-t pt-1">{t('headSignature')}</p>
      </footer>
    </article>
  );
}

// ─────────────────────────── Scores ───────────────────────────

function ScoresTab({ view }: { view: AdmissionTestClassView }) {
  const t = useTranslations('admissions.staff.test');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const { id, client, key } = useTest();
  const rowsKey = ['admission-scores', id];
  const rows = useQuery({
    queryKey: rowsKey,
    queryFn: () => client.api<AdmissionScoreRow[]>(`/admission/cycle-classes/${id}/scores`),
  });
  const [edits, setEdits] = useState<Record<string, { score: string; absent: boolean }>>({});
  const [bad, setBad] = useState<{ id: string; message: string } | null>(null);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const save = useMutation({
    mutationFn: async () => {
      const changed = Object.entries(edits).map(([applicationId, e]) => ({
        applicationId,
        score: e.absent ? null : e.score.trim() || null,
        absent: e.absent,
      }));
      let last: AdmissionScoreRow[] = [];
      for (let i = 0; i < changed.length; i += 500) {
        last = await client.api<AdmissionScoreRow[]>(`/admission/cycle-classes/${id}/scores`, {
          method: 'PUT',
          json: { rows: changed.slice(i, i + 500) },
        });
      }
      return last;
    },
    onSuccess: (r) => {
      queryClient.setQueryData(rowsKey, r);
      void queryClient.invalidateQueries({ queryKey: key });
      setEdits({});
      setBad(null);
      toast.success(t('savedScores'));
    },
    onError: (e) => {
      const code = errorCode(e);
      const applicationId =
        e && typeof e === 'object' && 'body' in e
          ? ((e as { body?: { applicationId?: string } }).body?.applicationId ?? null)
          : null;
      const message =
        code === 'SCORE_OUT_OF_RANGE'
          ? t('outOfRange')
          : code === 'SCORE_INVALID'
            ? t('invalid')
            : code === 'TEST_NOT_CONFIGURED'
              ? t('needFull')
              : describe(e);
      if (applicationId) setBad({ id: applicationId, message });
      toast.error(message);
    },
  });
  if (rows.isPending) return <Skeleton className="h-64 rounded-xl" />;
  const list = rows.data ?? [];
  if (list.length === 0) {
    return (
      <Alert>
        <AlertDescription>{t('noRolls')}</AlertDescription>
      </Alert>
    );
  }
  const value = (r: AdmissionScoreRow) =>
    edits[r.applicationId] ?? {
      score: r.scoreH != null ? formatMarks(r.scoreH, locale) : '',
      absent: r.absent,
    };
  const unsaved = Object.keys(edits).length;
  return (
    <SectionCard
      id="test-scores"
      title={t('tabs.scores')}
      hint={
        view.fullMarks
          ? `${t('scoresHint')} (${t('fullMarks')}: ${formatCount(view.fullMarks, locale)})`
          : t('needFull')
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="scores-grid">
          <thead>
            <tr className="border-b text-start">
              <th scope="col" className="py-2 text-start">
                {t('roll')}
              </th>
              <th scope="col" className="py-2 text-start">
                {t('name')}
              </th>
              <th scope="col" className="py-2 text-start">
                {t('score')}
              </th>
              <th scope="col" className="py-2 text-start">
                {t('absent')}
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => {
              const v = value(r);
              const update = (patch: Partial<typeof v>) =>
                setEdits({ ...edits, [r.applicationId]: { ...v, ...patch } });
              return (
                <tr key={r.applicationId} className="border-b" data-testid="score-row">
                  <td className="py-1 font-mono">{formatIdentifier(r.testRoll)}</td>
                  <td className="py-1">{displayName(r.nameBn, r.nameEn, locale)}</td>
                  <td className="py-1">
                    <input
                      ref={(el) => {
                        inputs.current[i] = el;
                      }}
                      aria-label={`${t('score')} ${formatIdentifier(r.testRoll)}`}
                      className={cn(
                        'border-input bg-background h-(--control-h) w-24 rounded-md border px-2',
                        bad?.id === r.applicationId && 'border-destructive',
                      )}
                      inputMode="decimal"
                      value={v.score}
                      disabled={v.absent}
                      onChange={(e) => update({ score: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          inputs.current[i + 1]?.focus();
                        }
                      }}
                      data-testid={`score-${r.testRoll}`}
                    />
                    {bad?.id === r.applicationId && (
                      <span className="text-destructive ms-2 text-xs">{bad.message}</span>
                    )}
                  </td>
                  <td className="py-1">
                    <input
                      type="checkbox"
                      aria-label={`${t('absent')} ${formatIdentifier(r.testRoll)}`}
                      className="size-5"
                      checked={v.absent}
                      onChange={(e) => update({ absent: e.target.checked, score: '' })}
                      data-testid={`absent-${r.testRoll}`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-end gap-3">
        {unsaved > 0 && (
          <span className="text-muted-foreground text-sm">
            {t('unsaved', { count: formatCount(unsaved, locale) })}
          </span>
        )}
        <Button
          onClick={() => save.mutate()}
          disabled={save.isPending || unsaved === 0}
          data-testid="save-scores"
        >
          {t('saveScores')}
        </Button>
      </div>
    </SectionCard>
  );
}

// ─────────────────────────── Merit list ───────────────────────────

function MeritTab({ view }: { view: AdmissionTestClassView }) {
  const t = useTranslations('admissions.staff.test');
  const ts = useTranslations('admissions.staff');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const { id, client, key } = useTest();
  const meritKey = ['admission-merit', id];
  const merit = useQuery({
    queryKey: meritKey,
    queryFn: () => client.api<AdmissionMeritView>(`/admission/cycle-classes/${id}/merit`),
  });
  const done = (m: AdmissionMeritView) => {
    queryClient.setQueryData(meritKey, m);
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: ['admission-sms-preview', id] });
  };
  const failed = (e: unknown) => {
    const code = errorCode(e);
    const body =
      e && typeof e === 'object' && 'body' in e
        ? (e as { body?: { count?: number } }).body
        : undefined;
    if (code === 'SCORES_MISSING') {
      toast.error(t('missing', { count: formatCount(body?.count ?? 0, locale) }));
    } else if (code === 'TEST_NOT_CONFIGURED') toast.error(t('notConfigured'));
    else if (code === 'MERIT_STALE' || code === 'MERIT_NOT_BUILT') toast.error(t('meritStale'));
    else toast.error(describe(e));
  };
  const build = useMutation({
    mutationFn: () =>
      client.api<AdmissionMeritView>(`/admission/cycle-classes/${id}/merit`, { method: 'POST' }),
    onSuccess: done,
    onError: failed,
  });
  const publish = useMutation({
    mutationFn: () =>
      client.api<AdmissionMeritView>(`/admission/cycle-classes/${id}/publish`, {
        method: 'POST',
        json: { builtAt: merit.data?.builtAt },
      }),
    onSuccess: done,
    onError: failed,
  });
  if (merit.isPending) return <Skeleton className="h-64 rounded-xl" />;
  const m = merit.data;
  if (!m) return null;
  const n = (x: number | null) => (x != null ? formatCount(x, locale) : '—');
  return (
    <SectionCard
      id="test-merit"
      title={t('tabs.merit')}
      hint={t('publishHint')}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => build.mutate()}
            disabled={build.isPending}
            data-testid="build-merit"
          >
            {t('build')}
          </Button>
          <Button
            onClick={() => publish.mutate()}
            disabled={publish.isPending || !m.builtAt || m.stale}
            data-testid="publish-merit"
          >
            {t('publish')}
          </Button>
        </div>
      }
    >
      <p className="text-sm" data-testid="merit-state">
        {m.builtAt ? t('built', { time: formatTime(m.builtAt, locale) }) : t('notBuilt')} ·{' '}
        {view.resultsPublishedAt
          ? t('published', {
              version: formatCount(view.resultsVersion, locale),
              time: formatDate(view.resultsPublishedAt, locale),
            })
          : t('notPublished')}
      </p>
      {m.stale && (
        <Alert>
          <AlertDescription>{t('stale')}</AlertDescription>
        </Alert>
      )}
      {view.changedSincePublish && !m.stale && (
        <Alert>
          <AlertDescription>{t('changedSincePublish')}</AlertDescription>
        </Alert>
      )}
      {m.boundaryTie > 0 && (
        <Alert data-testid="boundary-tie">
          <AlertDescription>
            {t('boundaryTie', { count: formatCount(m.boundaryTie, locale) })}
          </AlertDescription>
        </Alert>
      )}
      {m.waitlistTie > 0 && (
        <Alert>
          <AlertDescription>
            {t('waitlistTie', { count: formatCount(m.waitlistTie, locale) })}
          </AlertDescription>
        </Alert>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="merit-table">
          <thead>
            <tr className="border-b">
              <th scope="col" className="py-2 text-start">
                {t('place')}
              </th>
              <th scope="col" className="py-2 text-start">
                {t('roll')}
              </th>
              <th scope="col" className="py-2 text-start">
                {t('name')}
              </th>
              <th scope="col" className="py-2 text-start">
                {t('score')}
              </th>
              <th scope="col" className="py-2 text-start">
                {t('draft')}
              </th>
              <th scope="col" className="py-2 text-start">
                {t('waitlistPlace')}
              </th>
              <th scope="col" className="py-2 text-start">
                {t('statusCol')}
              </th>
            </tr>
          </thead>
          <tbody>
            {m.rows.map((r) => (
              <tr key={r.applicationId} className="border-b" data-testid="merit-row">
                <td className="py-1">{n(r.meritPosition)}</td>
                <td className="py-1 font-mono">{formatIdentifier(r.testRoll)}</td>
                <td className="py-1">
                  {displayName(r.nameBn, r.nameEn, locale)}
                  {r.resultFlag && (
                    <span className="text-destructive block text-xs">{t('flag')}</span>
                  )}
                </td>
                <td className="py-1">
                  {r.absent ? t('absent') : r.scoreH != null ? formatMarks(r.scoreH, locale) : '—'}
                </td>
                <td className="py-1">{r.testResult ? t(`results.${r.testResult}`) : '—'}</td>
                <td className="py-1">{n(r.waitlistPosition)}</td>
                <td className="py-1">
                  <Pill tone={APPLICATION_TONE[r.status]}>{ts(`appStatus.${r.status}`)}</Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ─────────────────────────── Result SMS and the waitlist ───────────────────────────

function SmsTab({ view }: { view: AdmissionTestClassView }) {
  const t = useTranslations('admissions.staff.test');
  const locale = useLocale() as Locale;
  const describe = useErrorMessage();
  const queryClient = useQueryClient();
  const { id, client, key } = useTest();
  const previewKey = ['admission-sms-preview', id];
  const preview = useQuery({
    queryKey: previewKey,
    queryFn: () =>
      client.api<AdmissionResultSmsPreview>(`/admission/cycle-classes/${id}/result-sms/preview`),
    enabled: view.resultsVersion > 0,
  });
  const [runId, setRunId] = useState<string | null>(null);
  const run = useQuery({
    queryKey: ['admission-sms-run', runId],
    queryFn: () =>
      client.api<{ counts: Record<string, number>; skipped: number }>(
        `/admission/result-sms/${runId}`,
      ),
    enabled: !!runId,
    refetchInterval: 3000,
  });
  const send = useMutation({
    mutationFn: () =>
      client.api<AdmissionResultSmsRun>(`/admission/cycle-classes/${id}/result-sms`, {
        method: 'POST',
        json: { expected: preview.data?.toSend ?? 0 },
      }),
    onSuccess: (r) => {
      setRunId(r.runId);
      toast.success(t('smsQueued', { count: formatCount(r.queued, locale) }));
      void queryClient.invalidateQueries({ queryKey: previewKey });
    },
    onError: (e) => {
      if (errorCode(e) === 'PREVIEW_CHANGED') toast.error(t('previewChanged'));
      else toast.error(describe(e));
      void queryClient.invalidateQueries({ queryKey: previewKey });
    },
  });
  const moveUp = useMutation({
    mutationFn: () =>
      client.api<AdmissionMoveUpResult>(`/admission/cycle-classes/${id}/move-up`, {
        method: 'POST',
      }),
    onSuccess: (r) => {
      toast.success(
        t('moved', { numbers: r.moved.map((m) => formatIdentifier(m.applicationNo)).join(', ') }),
      );
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: previewKey });
      void queryClient.invalidateQueries({ queryKey: ['admission-merit', id] });
    },
    onError: (e) => {
      const code = errorCode(e);
      if (code === 'NO_SEAT_FREE') toast.error(t('noSeat'));
      else if (code === 'WAITLIST_EMPTY') toast.error(t('waitlistEmpty'));
      else toast.error(describe(e));
    },
  });
  if (view.resultsVersion === 0) {
    return (
      <Alert>
        <AlertDescription>{t('notPublished')}</AlertDescription>
      </Alert>
    );
  }
  const p = preview.data;
  const r = run.data;
  return (
    <div className="flex flex-col gap-(--section-gap)">
      <SectionCard id="test-sms" title={t('smsTitle')} hint={t('smsHint')}>
        {p ? (
          <div className="flex flex-col gap-2 text-sm" data-testid="sms-preview">
            <p className="font-semibold">
              {t('smsToSend', { count: formatCount(p.toSend, locale) })}
            </p>
            <p>
              {t('smsCost', { cost: formatTaka(p.costPaisa, locale) })} ·{' '}
              {t('smsCapLeft', { count: formatCount(p.capLeftToday, locale) })}
            </p>
            {p.wouldBeSkipped > 0 && (
              <p className="text-destructive">
                {t('smsSkipped', { count: formatCount(p.wouldBeSkipped, locale) })}
              </p>
            )}
            {p.sampleText && (
              <p className="bg-muted rounded-md p-2">
                <span className="text-muted-foreground">{t('smsSample')}: </span>
                {p.sampleText}
              </p>
            )}
            <div className="flex justify-end">
              <Button
                onClick={() => send.mutate()}
                disabled={send.isPending || p.toSend === 0}
                data-testid="send-result-sms"
              >
                {t('smsSend', { count: formatCount(p.toSend, locale) })}
              </Button>
            </div>
            {r && (
              <p data-testid="sms-run">
                {t('smsRun', {
                  sent: formatCount(r.counts['SENT'] ?? 0, locale),
                  queued: formatCount(r.counts['QUEUED'] ?? 0, locale),
                  skipped: formatCount(r.skipped, locale),
                })}
              </p>
            )}
          </div>
        ) : (
          <Skeleton className="h-24 rounded-xl" />
        )}
      </SectionCard>
      <SectionCard id="test-waitlist" title={t('waitlist')} hint={t('waitlistHint')}>
        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => moveUp.mutate()}
            disabled={moveUp.isPending}
            data-testid="move-up"
          >
            {t('moveUp')}
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}

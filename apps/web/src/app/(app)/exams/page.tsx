'use client';

import {
  EXAM_KINDS,
  USUAL_RESULT_MODE,
  formatCount,
  type ExamDetail,
  type ExamKind,
  type ExamListItem,
  type MySheet,
  type SetupAcademicYear,
} from '@jantrik/shared';
import { BookOpenCheckIcon, ChevronRightIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  ExamDialog,
  ExamStatusPill,
  ExamsTabs,
  LoadError,
  SheetStatusPill,
  useExamLine,
  useName,
} from '@/components/exams/kit';
import { EmptyState } from '@/components/fees/setup/kit';
import { SectionCard, SelectField, TextField } from '@/components/form-kit';
import { FormGrid } from '@/components/form-layout';
import { PageGate } from '@/components/page-gate';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useExamMutation, useExamQuery, useExamRoles } from '@/lib/exams/api';
import { useMeContext } from '@/lib/hooks';

/** Exams: a teacher's own mark sheets first, then the year's exams (admins create them here). */
export default function ExamsPage() {
  return (
    <PageGate page="exams">
      <div className="flex flex-col gap-(--section-gap)">
        <ExamsTabs />
        <MySheets />
        <ExamList />
      </div>
    </PageGate>
  );
}

function MySheets() {
  const t = useTranslations('exams.list');
  const locale = useLocale() as Locale;
  const name = useName();
  const { data, isLoading, error, refetch } = useExamQuery<MySheet[]>('/exams/my-sheets');
  if (isLoading) return <Skeleton className="h-32 rounded-card" />;
  if (error) return <LoadError error={error} onRetry={() => void refetch()} />;
  if (!data || data.length === 0) return null;
  return (
    <SectionCard id="my-sheets" title={t('mySheets')} hint={t('mySheetsHint')}>
      <ul className="divide-y">
        {data.map((s) => (
          <li key={`${s.examSubjectId}:${s.section.id}`}>
            <Link
              href={`/exams/${s.exam.id}/sheet?subject=${s.examSubjectId}&section=${s.section.id}`}
              className="hover:bg-muted focus-visible:ring-ring flex min-h-14 items-center gap-3 rounded-lg px-2 py-2 outline-none focus-visible:ring-3"
              data-testid="my-sheet"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {name(s.subject)} · {name(s.section.classLevel)} {s.section.name}
                </span>
                <span className="text-muted-foreground block text-sm">
                  {name(s.exam)} ·{' '}
                  {t('entered', {
                    done: formatCount(s.entered, locale),
                    total: formatCount(s.total, locale),
                  })}
                </span>
                {s.returnNote && (
                  <span className="text-warning block text-sm">
                    {t('returnedNote', { note: s.returnNote })}
                  </span>
                )}
              </span>
              <SheetStatusPill status={s.status} />
              <ChevronRightIcon
                aria-hidden
                className="text-muted-foreground size-4 shrink-0 rtl:rotate-180"
              />
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function ExamList() {
  const t = useTranslations('exams.list');
  const locale = useLocale() as Locale;
  const name = useName();
  const line = useExamLine();
  const { isAdmin } = useExamRoles();
  const { data: context } = useMeContext();
  const [creating, setCreating] = useState(false);
  const yearId = context?.academicYear?.id;
  const { data, isLoading, error, refetch } = useExamQuery<ExamListItem[]>(
    yearId ? `/exams?academicYearId=${yearId}` : '/exams',
  );
  return (
    <SectionCard
      id="exam-list"
      title={t('title', { year: context?.academicYear?.name ?? '' })}
      actions={
        isAdmin && (
          <Button onClick={() => setCreating(true)} data-testid="exam-new">
            <PlusIcon aria-hidden />
            {t('new')}
          </Button>
        )
      }
    >
      {isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : error ? (
        <LoadError error={error} onRetry={() => void refetch()} />
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={BookOpenCheckIcon}
          title={t('emptyTitle')}
          text={isAdmin ? t('emptyAdmin') : t('emptyTeacher')}
        />
      ) : (
        <ul className="grid gap-(--gap) md:grid-cols-2 xl:grid-cols-3">
          {data.map((e) => (
            <li key={e.id}>
              <Link
                href={`/exams/${e.id}`}
                className="bg-card hover:shadow-card-hover focus-visible:ring-ring flex h-full flex-col gap-2 rounded-xl border p-4 transition-shadow outline-none focus-visible:ring-3"
                data-testid="exam-card"
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="font-semibold">{name(e)}</span>
                  <ExamStatusPill status={e.status} />
                </span>
                <span className="text-muted-foreground text-sm">{line(e)}</span>
                <span className="text-muted-foreground text-sm">
                  {t('classes', {
                    count: formatCount(e.classes.length, locale),
                    n: e.classes.length,
                    published: formatCount(e.classes.filter((c) => c.isPublished).length, locale),
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {creating && <CreateExamDialog onClose={() => setCreating(false)} />}
    </SectionCard>
  );
}

function CreateExamDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations('exams.list');
  const tKind = useTranslations('exams.common.kind');
  const tMode = useTranslations('exams.common.mode');
  const { client } = useAuth();
  const router = useRouter();
  const { data: context } = useMeContext();
  const years = useExamQuery<SetupAcademicYear[]>('/setup/academic-years');
  const [form, setForm] = useState({
    academicYearId: context?.academicYear?.id ?? '',
    kind: 'HALF_YEARLY' as ExamKind,
    nameBn: '',
    nameEn: '',
    startsOn: '',
    endsOn: '',
    resultMode: 'GPA' as 'GPA' | 'MARKS',
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const create = useExamMutation(
    () => client.api<ExamDetail>('/exams', { method: 'POST', json: form }),
    { success: t('created'), onSuccess: (exam) => router.push(`/exams/${exam.id}?tab=setup`) },
  );
  return (
    <ExamDialog
      onClose={onClose}
      title={t('newTitle')}
      description={t('newHint')}
      submitLabel={t('create')}
      pending={create.isPending}
      onSubmit={() => create.mutate(undefined)}
      testId="exam-new-dialog"
      submitTestId="exam-new-submit"
      wide
    >
      <FormGrid className="xl:grid-cols-2">
        <SelectField
          id="exam-year"
          label={t('year')}
          value={form.academicYearId}
          onChange={(v) => set({ academicYearId: v })}
          options={(years.data ?? []).map((y) => ({ value: y.id, label: y.name }))}
        />
        <SelectField
          id="exam-kind"
          label={t('kind')}
          value={form.kind}
          onChange={(v) => {
            const kind = v as ExamKind;
            set({ kind, resultMode: USUAL_RESULT_MODE[kind] });
          }}
          options={EXAM_KINDS.map((k) => ({ value: k, label: tKind(k) }))}
        />
        <TextField
          id="exam-name-bn"
          label={t('nameBn')}
          value={form.nameBn}
          onChange={(v) => set({ nameBn: v })}
          required
        />
        <TextField
          id="exam-name-en"
          label={t('nameEn')}
          value={form.nameEn}
          onChange={(v) => set({ nameEn: v })}
          required
        />
        <TextField
          id="exam-starts"
          label={t('startsOn')}
          type="date"
          value={form.startsOn}
          onChange={(v) => set({ startsOn: v })}
          required
        />
        <TextField
          id="exam-ends"
          label={t('endsOn')}
          type="date"
          value={form.endsOn}
          onChange={(v) => set({ endsOn: v })}
          required
        />
        <SelectField
          id="exam-mode"
          label={t('mode')}
          value={form.resultMode}
          onChange={(v) => set({ resultMode: v as 'GPA' | 'MARKS' })}
          options={(['GPA', 'MARKS'] as const).map((m) => ({ value: m, label: tMode(m) }))}
          hint={t('modeHint')}
        />
      </FormGrid>
    </ExamDialog>
  );
}

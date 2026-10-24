'use client';

import { formatCount, formatIdentifier, type RemarksView } from '@jantrik/shared';
import { ChevronLeftIcon, SaveIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { LoadError, useName } from '@/components/exams/kit';
import { PageGate } from '@/components/page-gate';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useExamMutation, useExamQuery } from '@/lib/exams/api';

const textareaClass =
  'min-h-16 w-full min-w-0 rounded-md border border-input bg-card px-3 py-2 text-(length:--input-fs) outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';

/** The class teacher's remark per student for the report cards (a phone list, saved together). */
export default function RemarksPage() {
  const { id } = useParams<{ id: string }>();
  const section = useSearchParams().get('section') ?? '';
  const t = useTranslations('exams.remarks');
  const { data, isLoading, error, refetch } = useExamQuery<RemarksView>(
    `/exams/${id}/remarks?sectionId=${section}`,
  );
  return (
    <PageGate page="exams">
      <div className="flex flex-col gap-(--section-gap)">
        <Link
          href={`/exams/${id}?tab=results`}
          className="text-muted-foreground hover:text-foreground inline-flex min-h-(--control-h) w-fit items-center gap-1 text-sm"
        >
          <ChevronLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
          {t('back')}
        </Link>
        {isLoading ? (
          <Skeleton className="rounded-card h-96" />
        ) : error || !data ? (
          <LoadError error={error} onRetry={() => void refetch()} />
        ) : (
          <RemarksForm key={section} examId={id} view={data} />
        )}
      </div>
    </PageGate>
  );
}

function RemarksForm({ examId, view }: { examId: string; view: RemarksView }) {
  const t = useTranslations('exams.remarks');
  const locale = useLocale() as Locale;
  const name = useName();
  const { client } = useAuth();
  const initial = Object.fromEntries(view.students.map((s) => [s.studentId, s.remarks ?? '']));
  const [text, setText] = useState<Record<string, string>>(initial);
  const changed = view.students.filter((s) => (text[s.studentId] ?? '') !== (s.remarks ?? ''));
  const save = useExamMutation(
    () =>
      client.api<RemarksView>(`/exams/${examId}/remarks`, {
        method: 'PUT',
        json: {
          sectionId: view.section.id,
          remarks: changed.map((s) => ({ studentId: s.studentId, text: text[s.studentId] ?? '' })),
        },
      }),
    { success: t('saved') },
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed.length > 0) save.mutate(undefined);
      }}
      data-testid="remarks"
    >
      <header>
        <h1 className="text-xl font-semibold">{t('title', { section: view.section.name })}</h1>
        <p className="text-muted-foreground text-sm">
          {view.isPublished ? t('publishedHint') : t('hint')}
        </p>
      </header>
      <ul className="bg-card rounded-card divide-y border">
        {view.students.map((s) => (
          <li key={s.studentId} className="flex flex-col gap-1.5 p-3">
            <label htmlFor={`remark-${s.studentId}`} className="flex items-baseline gap-2">
              <span className="bg-muted rounded px-1.5 font-mono text-xs">
                {s.roll != null ? formatIdentifier(s.roll) : '—'}
              </span>
              <span className="font-medium">{name(s)}</span>
            </label>
            <textarea
              id={`remark-${s.studentId}`}
              className={textareaClass}
              value={text[s.studentId] ?? ''}
              maxLength={300}
              rows={2}
              onChange={(e) => setText((x) => ({ ...x, [s.studentId]: e.target.value }))}
            />
          </li>
        ))}
      </ul>
      <div className="bg-background/95 sticky bottom-0 flex items-center gap-3 border-t py-3">
        <span className="text-muted-foreground flex-1 text-sm" aria-live="polite">
          {changed.length > 0
            ? t('unsaved', { count: formatCount(changed.length, locale) })
            : t('allSaved')}
        </span>
        <Button
          type="submit"
          disabled={changed.length === 0 || save.isPending}
          data-testid="remarks-save"
        >
          <SaveIcon aria-hidden />
          {t('save')}
        </Button>
      </div>
    </form>
  );
}

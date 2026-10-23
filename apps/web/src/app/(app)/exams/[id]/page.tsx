'use client';

import type { ExamDetail } from '@jantrik/shared';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ExamHeader } from '@/components/exams/exam-header';
import { ExamSetupPanel } from '@/components/exams/exam-setup-panel';
import { ExamsTabs, LoadError } from '@/components/exams/kit';
import { ResultsPanel } from '@/components/exams/results-panel';
import { SheetsGrid } from '@/components/exams/sheets-grid';
import { StudentsPanel } from '@/components/exams/students-panel';
import { SegmentedControl } from '@/components/kit/segmented-control';
import { PageGate } from '@/components/page-gate';
import { Skeleton } from '@/components/ui/skeleton';
import { useExamQuery, useExamRoles } from '@/lib/exams/api';

const TABS = ['sheets', 'setup', 'students', 'results'] as const;
type Tab = (typeof TABS)[number];

/** One exam: its sheets, setup, roster and seats, and results (admins); teachers see their sheets. */
export default function ExamPage() {
  const { id } = useParams<{ id: string }>();
  const t = useTranslations('exams.detail');
  const router = useRouter();
  const params = useSearchParams();
  const { isAdmin, ready } = useExamRoles();
  const { data: exam, isLoading, error, refetch } = useExamQuery<ExamDetail>(`/exams/${id}`);
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'sheets') as Tab;
  const setTab = (next: Tab) => router.replace(`/exams/${id}?tab=${next}`, { scroll: false });

  return (
    <PageGate page="exams">
      <div className="flex flex-col gap-(--section-gap)">
        <ExamsTabs />
        {isLoading || !ready ? (
          <Skeleton className="h-64 rounded-card" />
        ) : error || !exam ? (
          <LoadError error={error} onRetry={() => void refetch()} />
        ) : (
          <>
            <ExamHeader exam={exam} />
            {isAdmin && (
              <SegmentedControl
                label={t('sections')}
                value={tab}
                onChange={setTab}
                options={TABS.map((k) => ({ value: k, label: t(`tab.${k}`) }))}
                testId="exam-tabs"
                className="print:hidden"
              />
            )}
            {!isAdmin || tab === 'sheets' ? (
              <SheetsGrid exam={exam} />
            ) : tab === 'setup' ? (
              <ExamSetupPanel exam={exam} />
            ) : tab === 'students' ? (
              <StudentsPanel exam={exam} />
            ) : (
              <ResultsPanel exam={exam} />
            )}
          </>
        )}
      </div>
    </PageGate>
  );
}

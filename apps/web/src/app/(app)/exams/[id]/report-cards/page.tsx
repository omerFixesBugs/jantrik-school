'use client';

import type { ReportCards } from '@jantrik/shared';
import { useParams, useSearchParams } from 'next/navigation';
import { LoadError } from '@/components/exams/kit';
import { PrintToolbar } from '@/components/exams/print-pages';
import { ReportCardsPrint } from '@/components/exams/report-card';
import { PageGate } from '@/components/page-gate';
import { Skeleton } from '@/components/ui/skeleton';
import { useExamQuery } from '@/lib/exams/api';

/** Published report cards of a section (or one student): A4 portrait, one per page. */
export default function ReportCardsPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const section = params.get('section');
  const student = params.get('student');
  const query = section ? `sectionId=${section}` : `studentId=${student ?? ''}`;
  const { data, isLoading, error, refetch } = useExamQuery<ReportCards>(
    `/exams/${id}/report-cards?${query}`,
  );
  return (
    <PageGate page="exams">
      <div className="flex flex-col gap-(--section-gap)">
        <PrintToolbar examId={id} />
        {isLoading ? (
          <Skeleton className="h-[60vh] rounded-card" />
        ) : error || !data ? (
          <LoadError error={error} onRetry={() => void refetch()} />
        ) : (
          <ReportCardsPrint data={data} />
        )}
      </div>
    </PageGate>
  );
}

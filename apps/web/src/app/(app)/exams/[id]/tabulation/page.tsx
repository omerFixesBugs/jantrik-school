'use client';

import type { Tabulation } from '@jantrik/shared';
import { useParams, useSearchParams } from 'next/navigation';
import { LoadError } from '@/components/exams/kit';
import { TabulationSheet } from '@/components/exams/print-pages';
import { PageGate } from '@/components/page-gate';
import { Skeleton } from '@/components/ui/skeleton';
import { useExamQuery } from '@/lib/exams/api';

/** The tabulation sheet of one class (or one section): print on A4 landscape, or CSV. */
export default function TabulationPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const examClassId = params.get('class') ?? '';
  const section = params.get('section');
  const { data, isLoading, error, refetch } = useExamQuery<Tabulation>(
    `/exams/${id}/classes/${examClassId}/tabulation${section ? `?sectionId=${section}` : ''}`,
  );
  return (
    <PageGate page="exams">
      {isLoading ? (
        <Skeleton className="h-96 rounded-card" />
      ) : error || !data ? (
        <LoadError error={error} onRetry={() => void refetch()} />
      ) : (
        <TabulationSheet data={data} examId={id} examClassId={examClassId} />
      )}
    </PageGate>
  );
}

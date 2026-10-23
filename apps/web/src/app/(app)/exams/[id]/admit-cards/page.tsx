'use client';

import type { AdmitCards } from '@jantrik/shared';
import { useParams, useSearchParams } from 'next/navigation';
import { LoadError } from '@/components/exams/kit';
import { AdmitCardsPrint } from '@/components/exams/print-pages';
import { PageGate } from '@/components/page-gate';
import { Skeleton } from '@/components/ui/skeleton';
import { useExamQuery } from '@/lib/exams/api';

/** Admit cards of a section (two per A4 sheet). */
export default function AdmitCardsPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const section = params.get('section') ?? '';
  const { data, isLoading, error, refetch } = useExamQuery<AdmitCards>(
    `/exams/${id}/admit-cards?sectionId=${section}`,
  );
  return (
    <PageGate page="exams">
      {isLoading ? (
        <Skeleton className="h-96 rounded-card" />
      ) : error || !data ? (
        <LoadError error={error} onRetry={() => void refetch()} />
      ) : (
        <AdmitCardsPrint data={data} examId={id} />
      )}
    </PageGate>
  );
}

'use client';

import type { SeatPlan } from '@jantrik/shared';
import { useParams } from 'next/navigation';
import { LoadError } from '@/components/exams/kit';
import { SeatPlanPrint } from '@/components/exams/print-pages';
import { PageGate } from '@/components/page-gate';
import { Skeleton } from '@/components/ui/skeleton';
import { useExamQuery } from '@/lib/exams/api';

/** The seat plan, room by room (A4 landscape). */
export default function SeatsPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error, refetch } = useExamQuery<SeatPlan>(`/exams/${id}/seats`);
  return (
    <PageGate page="exams">
      {isLoading ? (
        <Skeleton className="h-96 rounded-card" />
      ) : error || !data ? (
        <LoadError error={error} onRetry={() => void refetch()} />
      ) : (
        <SeatPlanPrint data={data} examId={id} />
      )}
    </PageGate>
  );
}

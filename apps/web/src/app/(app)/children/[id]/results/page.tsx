'use client';

import { useParams } from 'next/navigation';
import { ChildResultsList, GuardianExamsGate } from '@/components/exams/guardian';

/** A guardian's view of one child's published exam results. */
export default function ChildResultsPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <GuardianExamsGate>
      <ChildResultsList childId={id} />
    </GuardianExamsGate>
  );
}

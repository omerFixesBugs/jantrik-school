'use client';

import { useParams } from 'next/navigation';
import { ChildReportCard, GuardianExamsGate } from '@/components/exams/guardian';

/** One published report card of a guardian's child (printable). */
export default function ChildReportCardPage() {
  const { id, ecId } = useParams<{ id: string; ecId: string }>();
  return (
    <GuardianExamsGate>
      <ChildReportCard childId={id} examClassId={ecId} />
    </GuardianExamsGate>
  );
}

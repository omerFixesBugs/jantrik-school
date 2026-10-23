'use client';

import { useParams } from 'next/navigation';
import { ChildFeesView } from '@/components/fees/guardian/child-fees-view';
import { GuardianFeesGate } from '@/components/fees/guardian/guardian-gate';

/** A guardian's view of one child's fees: what is owed, reporting a bKash/Nagad payment, receipts. */
export default function ChildFeesPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <GuardianFeesGate>
      <ChildFeesView childId={id} />
    </GuardianFeesGate>
  );
}

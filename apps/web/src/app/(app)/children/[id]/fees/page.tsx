'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { ChildFeesView } from '@/components/fees/guardian/child-fees-view';
import { GuardianFeesGate } from '@/components/fees/guardian/guardian-gate';

/**
 * A guardian's view of one child's fees: what is owed, paying online or reporting a bKash/Nagad
 * payment, receipts.
 */
export default function ChildFeesPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <GuardianFeesGate>
      {/* useSearchParams ("start again" opens the online sheet) needs a Suspense boundary. */}
      <Suspense>
        <ChildFeesView childId={id} />
      </Suspense>
    </GuardianFeesGate>
  );
}

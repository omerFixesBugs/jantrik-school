'use client';

import { useParams } from 'next/navigation';
import { ChildReceiptView } from '@/components/fees/guardian/child-receipt-view';
import { GuardianFeesGate } from '@/components/fees/guardian/guardian-gate';

/** One of a child's receipts, for the guardian to keep or print (A5 or 80 mm). */
export default function ChildReceiptPage() {
  const { id, paymentId } = useParams<{ id: string; paymentId: string }>();
  return (
    <GuardianFeesGate>
      <ChildReceiptView childId={id} paymentId={paymentId} />
    </GuardianFeesGate>
  );
}

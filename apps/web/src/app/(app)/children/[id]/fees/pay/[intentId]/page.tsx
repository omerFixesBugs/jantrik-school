'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { GuardianFeesGate } from '@/components/fees/guardian/guardian-gate';
import { OnlinePaymentPage } from '@/components/fees/guardian/online-payment-view';

/** One online payment of a child: on to SSLCommerz, back from it, and how it ended. */
export default function ChildOnlinePaymentPage() {
  const { id, intentId } = useParams<{ id: string; intentId: string }>();
  return (
    <GuardianFeesGate>
      {/* useSearchParams (the way back from the gateway) needs a Suspense boundary. */}
      <Suspense>
        <OnlinePaymentPage childId={id} intentId={intentId} />
      </Suspense>
    </GuardianFeesGate>
  );
}

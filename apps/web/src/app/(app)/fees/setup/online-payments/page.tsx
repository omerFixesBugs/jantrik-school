'use client';

import { OnlinePaymentsSection } from '@/components/fees/setup/online-payments-section';
import { FeeSetupFrame } from '@/components/fees/setup/setup-frame';

/** Fee setup → online payments through SSLCommerz, sandbox only (OWNER; docs/payments.md). */
export default function Page() {
  return (
    <FeeSetupFrame tab="online">
      <OnlinePaymentsSection />
    </FeeSetupFrame>
  );
}

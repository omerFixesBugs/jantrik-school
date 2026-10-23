'use client';

import { AmountsSection } from '@/components/fees/setup/amounts-section';
import { FeeSetupFrame } from '@/components/fees/setup/setup-frame';

/** Fee setup → amounts per class (OWNER/ADMIN). */
export default function Page() {
  return (
    <FeeSetupFrame tab="amounts">
      <AmountsSection />
    </FeeSetupFrame>
  );
}

'use client';

import { NumbersSection } from '@/components/fees/setup/numbers-section';
import { FeeSetupFrame } from '@/components/fees/setup/setup-frame';

/** Fee setup → the institute's bKash/Nagad numbers (OWNER/ADMIN). */
export default function Page() {
  return (
    <FeeSetupFrame tab="numbers">
      <NumbersSection />
    </FeeSetupFrame>
  );
}

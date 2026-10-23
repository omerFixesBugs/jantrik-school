'use client';

import { ConcessionsSection } from '@/components/fees/setup/concessions-section';
import { FeeSetupFrame } from '@/components/fees/setup/setup-frame';

/** Fee setup → concessions (OWNER/ADMIN). */
export default function Page() {
  return (
    <FeeSetupFrame tab="concessions">
      <ConcessionsSection />
    </FeeSetupFrame>
  );
}

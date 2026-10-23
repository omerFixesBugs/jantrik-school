'use client';

import { HeadsSection } from '@/components/fees/setup/heads-section';
import { FeeSetupFrame } from '@/components/fees/setup/setup-frame';

/** Fee setup → fee heads (OWNER/ADMIN). */
export default function Page() {
  return (
    <FeeSetupFrame tab="heads">
      <HeadsSection />
    </FeeSetupFrame>
  );
}

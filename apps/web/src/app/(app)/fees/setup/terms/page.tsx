'use client';

import { TermsSection } from '@/components/fees/setup/terms-section';
import { FeeSetupFrame } from '@/components/fees/setup/setup-frame';

/** Fee setup → terms (OWNER/ADMIN). */
export default function Page() {
  return (
    <FeeSetupFrame tab="terms">
      <TermsSection />
    </FeeSetupFrame>
  );
}

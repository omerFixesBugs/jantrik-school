'use client';

import { GeneralSection } from '@/components/fees/setup/general-section';
import { FeeSetupFrame } from '@/components/fees/setup/setup-frame';

/** Fee setup → start and general settings (OWNER/ADMIN). */
export default function Page() {
  return (
    <FeeSetupFrame tab="general">
      <GeneralSection />
    </FeeSetupFrame>
  );
}

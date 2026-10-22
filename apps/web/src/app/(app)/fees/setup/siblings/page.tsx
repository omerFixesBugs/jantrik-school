'use client';

import { SiblingsSection } from '@/components/fees/setup/siblings-section';
import { FeeSetupFrame } from '@/components/fees/setup/setup-frame';

/** Fee setup → sibling families (OWNER/ADMIN). */
export default function Page() {
  return (
    <FeeSetupFrame tab="siblings">
      <SiblingsSection />
    </FeeSetupFrame>
  );
}

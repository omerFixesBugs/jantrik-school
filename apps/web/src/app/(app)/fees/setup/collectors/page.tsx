'use client';

import { CollectorsSection } from '@/components/fees/setup/collectors-section';
import { FeeSetupFrame } from '@/components/fees/setup/setup-frame';

/** Fee setup → who collects fees (OWNER/ADMIN). */
export default function Page() {
  return (
    <FeeSetupFrame tab="collectors">
      <CollectorsSection />
    </FeeSetupFrame>
  );
}

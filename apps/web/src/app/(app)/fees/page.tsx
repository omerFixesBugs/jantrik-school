'use client';

import { ComingSoon, PageGate } from '@/components/page-gate';
import { useNavLabel } from '@/components/app-shell';

export default function Page() {
  const navLabel = useNavLabel();
  return (
    <PageGate page="fees">
      <ComingSoon title={navLabel('fees')} />
    </PageGate>
  );
}

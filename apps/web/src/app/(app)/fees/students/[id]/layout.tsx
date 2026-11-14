import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// A student's fee ledger: its extra texts (src/i18n/route-messages.ts).
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="feeLedger">{children}</RouteMessages>;
}

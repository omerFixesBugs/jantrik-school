import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// Mobile payment submissions use the fee reports' texts (src/i18n/route-messages.ts).
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="feeReports">{children}</RouteMessages>;
}

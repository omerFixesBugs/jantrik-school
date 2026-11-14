import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// Print pages' texts (src/i18n/route-messages.ts).
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="examPrint">{children}</RouteMessages>;
}

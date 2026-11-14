import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// The dashboard's texts, for every role's view (src/i18n/route-messages.ts).
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="dashboard">{children}</RouteMessages>;
}

import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// Marks entry's texts (src/i18n/route-messages.ts).
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="examSheet">{children}</RouteMessages>;
}

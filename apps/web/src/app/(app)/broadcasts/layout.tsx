import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// SMS broadcasts' texts (OWNER/ADMIN; src/i18n/route-messages.ts).
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="broadcasts">{children}</RouteMessages>;
}

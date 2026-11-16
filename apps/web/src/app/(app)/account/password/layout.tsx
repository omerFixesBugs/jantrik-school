import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// The person's own account texts (src/i18n/route-messages.ts).
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="account">{children}</RouteMessages>;
}

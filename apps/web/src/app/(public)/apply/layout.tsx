import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// The public admission form (sprint 1 P3b): its own texts; no login, no app shell.
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="apply">{children}</RouteMessages>;
}

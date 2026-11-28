import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// The new-year wizard's texts (and a run's page below it), on top of setup's.
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="newYear">{children}</RouteMessages>;
}

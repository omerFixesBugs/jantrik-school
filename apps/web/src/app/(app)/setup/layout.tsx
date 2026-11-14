import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// Institute setup's texts; the welcome wizard adds its own below.
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="setup">{children}</RouteMessages>;
}

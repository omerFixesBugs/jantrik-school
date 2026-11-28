import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// Admission for staff (sprint 1 P3a): cycles, applications and approval.
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="admission">{children}</RouteMessages>;
}

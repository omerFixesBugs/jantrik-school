import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// The students list's texts; admission, the profile and the import add theirs below.
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="students">{children}</RouteMessages>;
}

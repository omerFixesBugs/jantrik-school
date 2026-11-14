import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// The login page's texts (docs/design.md → Performance budget: each route sends its own).
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="login">{children}</RouteMessages>;
}

import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// The platform area's texts (each route sends its own: src/i18n/route-messages.ts).
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="platform">{children}</RouteMessages>;
}

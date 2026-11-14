import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// A guardian's child pages (fees, results): their texts (src/i18n/route-messages.ts).
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="children">{children}</RouteMessages>;
}

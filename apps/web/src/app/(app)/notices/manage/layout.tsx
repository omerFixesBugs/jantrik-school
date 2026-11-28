import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// Notice management's texts (OWNER/ADMIN), on top of the board's.
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="noticesManage">{children}</RouteMessages>;
}

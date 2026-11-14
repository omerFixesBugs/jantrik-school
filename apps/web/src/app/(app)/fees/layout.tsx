import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// The fee counter's texts (search, ledger, receipts, closing); setup and reports add theirs.
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="fees">{children}</RouteMessages>;
}

import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// The exams list's texts; setup, an exam, its sheets and prints add theirs below.
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="exams">{children}</RouteMessages>;
}

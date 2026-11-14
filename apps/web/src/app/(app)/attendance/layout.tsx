import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';

// Attendance's texts (take, register, a student's month); the other screens add theirs below.
export default function Layout({ children }: { children: ReactNode }) {
  return <RouteMessages area="attendance">{children}</RouteMessages>;
}

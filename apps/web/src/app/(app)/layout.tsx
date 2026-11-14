import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';
import { AppFrame } from './app-frame';

/** The institute app: the shell's texts (src/i18n/route-messages.ts), then the frame. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <RouteMessages area="app">
      <AppFrame>{children}</AppFrame>
    </RouteMessages>
  );
}

import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { RouteMessages } from '@/i18n/route-messages-provider';
import { CONFIGURED_API_URL } from '@/lib/api/api-url';
import { bootRefreshEnabled, bootRefreshScript } from '@/lib/auth/boot-refresh';
import { AppFrame } from './app-frame';
import { BootRefreshScript } from './boot-refresh-script';

/**
 * The institute app: the boot refresh script (only here: never on the platform panel or the
 * public pages), the shell's texts (src/i18n/route-messages.ts), then the frame.
 * `JANTRIK_BOOT_REFRESH=off` on the web server leaves the script out from the next request on.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  await connection(); // read the switch per request, not at build time
  const boot = bootRefreshEnabled(process.env['JANTRIK_BOOT_REFRESH'])
    ? bootRefreshScript(CONFIGURED_API_URL, process.env.NODE_ENV === 'development')
    : null;
  return (
    <>
      {boot && <BootRefreshScript script={boot} />}
      <RouteMessages area="app">
        <AppFrame>{children}</AppFrame>
      </RouteMessages>
    </>
  );
}

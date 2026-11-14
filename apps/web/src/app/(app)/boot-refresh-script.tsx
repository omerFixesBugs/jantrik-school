'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;

/**
 * The boot refresh script (lib/auth/boot-refresh.ts) as the server rendered it. The browser runs
 * it while parsing the HTML. On a client-side render (login → dashboard) React would only create
 * a dead copy, and development reports that as an error, so then nothing is rendered: the server
 * snapshot (true) covers the server render and hydration, the client one (false) everything else.
 */
export function BootRefreshScript({ script }: { script: string }) {
  const fromServer = useSyncExternalStore(
    subscribe,
    () => false,
    () => true,
  );
  return fromServer ? (
    <script id="boot-refresh" dangerouslySetInnerHTML={{ __html: script }} />
  ) : null;
}

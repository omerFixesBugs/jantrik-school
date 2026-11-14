import { getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';
import { MergeMessages } from './merge-messages';
import { pickMessages, ROUTE_MESSAGES, type RouteArea } from './route-messages';

/** Sends one area's messages to the browser (route-messages.ts); used by area layouts. */
export async function RouteMessages({ area, children }: { area: RouteArea; children: ReactNode }) {
  const messages = pickMessages(await getMessages(), ROUTE_MESSAGES[area]);
  return <MergeMessages messages={messages}>{children}</MergeMessages>;
}

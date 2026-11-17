'use client';

import { useQuery } from '@tanstack/react-query';
import type { NoticeManageItem } from '@jantrik/shared';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { BroadcastComposer } from '@/components/notices/broadcast-composer';
import { PageGate } from '@/components/page-gate';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth/auth-provider';
import { useMeContext } from '@/lib/hooks';

/**
 * A new broadcast. From a notice (`?notice=<id>`), the text starts with the institute's name, a
 * colon and the notice's title, which the admin may change (P6-M); otherwise with the name only.
 */
export default function NewBroadcastPage() {
  return (
    <Suspense>
      <NewBroadcast />
    </Suspense>
  );
}

function NewBroadcast() {
  const noticeId = useSearchParams().get('notice');
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const notice = useQuery({
    queryKey: ['notices', session?.tenant?.id, 'manage', noticeId],
    queryFn: () => client.api<NoticeManageItem>(`/notices/manage/${noticeId}`),
    enabled: Boolean(noticeId),
  });
  if (!context || (noticeId && notice.isPending)) {
    return (
      <PageGate page="broadcasts">
        <Skeleton className="h-96" />
      </PageGate>
    );
  }
  const prefix = `${context.tenant.name}: `;
  return (
    <PageGate page="broadcasts">
      <BroadcastComposer
        initialBody={notice.data ? `${prefix}${notice.data.title}` : prefix}
        noticeId={notice.data?.id ?? null}
      />
    </PageGate>
  );
}

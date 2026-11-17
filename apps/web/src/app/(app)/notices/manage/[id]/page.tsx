'use client';

import { useQuery } from '@tanstack/react-query';
import type { NoticeManageItem } from '@jantrik/shared';
import { useParams } from 'next/navigation';
import { NoticeForm } from '@/components/notices/notice-form';
import { ContextGate } from '@/components/page-gate';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth/auth-provider';

/** Edit a notice (not a withdrawn one: the API answers 409 NOT_EDITABLE). */
export default function EditNoticePage() {
  const { id } = useParams<{ id: string }>();
  const { client, session } = useAuth();
  const notice = useQuery({
    queryKey: ['notices', session?.tenant?.id, 'manage', id],
    queryFn: () => client.api<NoticeManageItem>(`/notices/manage/${id}`),
  });
  return (
    <ContextGate allow={(c) => c.roles.includes('OWNER') || c.roles.includes('ADMIN')}>
      {notice.data ? <NoticeForm notice={notice.data} /> : <Skeleton className="h-96" />}
    </ContextGate>
  );
}

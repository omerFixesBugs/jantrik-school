'use client';

import type { PlatformAuditEntry } from '@jantrik/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { AuditList } from '@/components/platform/audit-list';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { platformApi } from '@/lib/platform/platform-api';

const PAGE = 50;

/** Everything platform admins and the CLI did, newest first. */
export default function PlatformAuditPage() {
  const t = useTranslations('platform');
  const audit = useInfiniteQuery({
    queryKey: ['platform-audit', 'all'],
    initialPageParam: null as { before: string; beforeId: string } | null,
    queryFn: ({ pageParam }) =>
      platformApi<PlatformAuditEntry[]>(
        `/platform/audit?limit=${PAGE}${
          pageParam
            ? `&before=${encodeURIComponent(pageParam.before)}&beforeId=${pageParam.beforeId}`
            : ''
        }`,
      ),
    getNextPageParam: (last) =>
      last.length === PAGE ? { before: last.at(-1)!.createdAt, beforeId: last.at(-1)!.id } : null,
  });
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-2xl font-semibold">{t('auditTitle')}</h1>
        <p className="text-muted-foreground">{t('auditText')}</p>
      </div>
      {audit.data ? (
        <AuditList entries={audit.data.pages.flat()} />
      ) : (
        <Skeleton className="h-64 rounded-xl" />
      )}
      {audit.hasNextPage && (
        <Button
          variant="outline"
          className="self-start"
          disabled={audit.isFetchingNextPage}
          onClick={() => void audit.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      )}
    </div>
  );
}

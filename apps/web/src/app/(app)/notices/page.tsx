'use client';

import { useQuery } from '@tanstack/react-query';
import { formatDate, type NoticeBoardItem } from '@jantrik/shared';
import { PinIcon, SettingsIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { SectionCard } from '@/components/form-kit';
import { PageGate } from '@/components/page-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { useMeContext } from '@/lib/hooks';
import { noticeKeys } from '@/lib/notices';
import { cn } from '@/lib/utils';

/** The notice board: what this person may see, pinned first, then newest (sprint 1 P6). */
export default function NoticesPage() {
  const t = useTranslations('notices.board');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const { data: context } = useMeContext();
  const canManage = context?.roles.some((r) => r === 'OWNER' || r === 'ADMIN') ?? false;
  const board = useQuery({
    queryKey: noticeKeys.board(session?.tenant?.id),
    queryFn: () => client.api<NoticeBoardItem[]>('/notices'),
  });

  return (
    <PageGate page="notices">
      <SectionCard
        id="notices"
        title={t('title')}
        hint={t('hint')}
        actions={
          canManage ? (
            <ButtonLink variant="outline" href="/notices/manage">
              <SettingsIcon aria-hidden />
              {t('manage')}
            </ButtonLink>
          ) : undefined
        }
      >
        {board.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        ) : board.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{t('loadError')}</AlertDescription>
          </Alert>
        ) : board.data.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="notice-board">
            {board.data.map((n) => (
              <li key={n.id}>
                <Link
                  href={`/notices/${n.id}`}
                  className={cn(
                    'bg-card hover:bg-muted focus-visible:ring-ring flex flex-col gap-1.5 rounded-xl border p-4 outline-none focus-visible:ring-2',
                    !n.read && 'border-primary/40',
                  )}
                  data-testid="notice-card"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    {!n.read && (
                      <span
                        role="img"
                        className="bg-primary size-2 shrink-0 rounded-full"
                        aria-label={t('unread')}
                      />
                    )}
                    <span className="min-w-0 flex-1 font-semibold break-words">{n.title}</span>
                    {n.pinned && (
                      <span className="text-primary-ink flex items-center gap-1 text-xs">
                        <PinIcon aria-hidden className="size-3.5" />
                        {t('pinned')}
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground line-clamp-2 text-sm whitespace-pre-line">
                    {n.excerpt}
                  </span>
                  <span className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
                    <span>{t('published', { date: formatDate(n.publishAt, locale) })}</span>
                    {n.edited && <span>{t('edited')}</span>}
                    {n.expiresAt && (
                      <span>{t('expires', { date: formatDate(n.expiresAt, locale) })}</span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </PageGate>
  );
}

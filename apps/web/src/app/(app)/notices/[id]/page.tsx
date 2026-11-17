'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate, type NoticeDetail } from '@jantrik/shared';
import { ArrowLeftIcon, PinIcon } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { PageGate } from '@/components/page-gate';
import { ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { noticeKeys } from '@/lib/notices';

/** One notice in full (line breaks kept, links as plain text: P6-J); marked read on open. */
export default function NoticePage() {
  const t = useTranslations('notices.board');
  const locale = useLocale() as Locale;
  const { id } = useParams<{ id: string }>();
  const { client, session } = useAuth();
  const tenantId = session?.tenant?.id;
  const queryClient = useQueryClient();
  const notice = useQuery({
    queryKey: ['notices', tenantId, 'one', id],
    queryFn: () => client.api<NoticeDetail>(`/notices/${id}`),
    retry: false,
  });
  const markRead = useMutation({
    mutationFn: () => client.api<void>(`/notices/${id}/read`, { method: 'POST', json: {} }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: noticeKeys.unread(tenantId) }),
        queryClient.invalidateQueries({ queryKey: noticeKeys.board(tenantId) }),
      ]),
  });
  const unread = notice.data ? !notice.data.read : false;
  const { mutate } = markRead;
  useEffect(() => {
    if (unread) mutate();
  }, [unread, mutate]);

  return (
    <PageGate page="notices">
      <article className="bg-card rounded-card shadow-card flex flex-col gap-4 border p-(--panel-p)">
        <ButtonLink variant="ghost" href="/notices" className="self-start">
          <ArrowLeftIcon aria-hidden />
          {t('back')}
        </ButtonLink>
        {notice.isPending ? (
          <Skeleton className="h-40" />
        ) : notice.isError ? (
          <p className="text-muted-foreground py-6 text-center">{t('notFound')}</p>
        ) : (
          <>
            <header className="flex flex-col gap-1">
              <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold break-words">
                {notice.data.title}
                {notice.data.pinned && (
                  <PinIcon aria-label={t('pinned')} className="text-primary-ink size-4" />
                )}
              </h2>
              <p className="text-muted-foreground flex flex-wrap gap-x-3 text-sm">
                <span>{t('published', { date: formatDate(notice.data.publishAt, locale) })}</span>
                {notice.data.edited && <span>{t('edited')}</span>}
                {notice.data.expiresAt && (
                  <span>{t('expires', { date: formatDate(notice.data.expiresAt, locale) })}</span>
                )}
              </p>
            </header>
            <div
              className="leading-relaxed break-words whitespace-pre-line"
              data-testid="notice-body"
            >
              {notice.data.body}
            </div>
          </>
        )}
      </article>
    </PageGate>
  );
}

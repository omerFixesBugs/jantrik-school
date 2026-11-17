'use client';

import { useQuery } from '@tanstack/react-query';
import { formatDate, type NoticeBoardItem } from '@jantrik/shared';
import { ArrowRightIcon, MegaphoneIcon, PinIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ButtonLink } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { noticeKeys } from '@/lib/notices';

/** The dashboard's "Notices" card: pinned first, then the newest, three at most (P6). */
export function NoticesCard() {
  const t = useTranslations('notices.board');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const board = useQuery({
    queryKey: noticeKeys.board(session?.tenant?.id),
    queryFn: () => client.api<NoticeBoardItem[]>('/notices'),
  });
  if (!board.data) return null;
  const top = board.data.slice(0, 3);
  return (
    <section
      className="bg-card rounded-card shadow-card flex flex-col gap-3 border p-(--panel-p)"
      aria-labelledby="dashboard-notices"
      data-testid="dashboard-notices"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="dashboard-notices" className="flex items-center gap-2 font-semibold">
          <MegaphoneIcon aria-hidden className="text-primary-ink size-4.5" />
          {t('dashboardTitle')}
        </h2>
        <ButtonLink variant="ghost" size="sm" href="/notices">
          {t('dashboardAll')}
          <ArrowRightIcon aria-hidden className="rtl:rotate-180" />
        </ButtonLink>
      </div>
      {top.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('dashboardEmpty')}</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {top.map((n) => (
            <li key={n.id}>
              <Link
                href={`/notices/${n.id}`}
                className="hover:bg-muted flex items-center gap-2 rounded-md px-1 py-2"
              >
                {!n.read && (
                  <span
                    role="img"
                    className="bg-primary size-2 shrink-0 rounded-full"
                    aria-label={t('unread')}
                  />
                )}
                {n.pinned && <PinIcon aria-label={t('pinned')} className="size-3.5 shrink-0" />}
                <span className="min-w-0 flex-1 truncate">{n.title}</span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {formatDate(n.publishAt, locale)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

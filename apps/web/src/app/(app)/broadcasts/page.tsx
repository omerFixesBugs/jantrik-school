'use client';

import { useQuery } from '@tanstack/react-query';
import { formatCount, formatDate, formatTime, type BroadcastView } from '@jantrik/shared';
import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { SectionCard } from '@/components/form-kit';
import { PageGate } from '@/components/page-gate';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { BROADCAST_STATUS_VARIANT as STATUS_VARIANT } from '@/lib/notices';

/** SMS broadcasts (OWNER/ADMIN): status and live counts; opening it re-queues overdue ones. */
export default function BroadcastsPage() {
  const t = useTranslations('notices.broadcasts');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const list = useQuery({
    queryKey: ['broadcasts', session?.tenant?.id],
    queryFn: () => client.api<BroadcastView[]>('/broadcasts'),
  });
  const when = (iso: string) => ({ date: formatDate(iso, locale), time: formatTime(iso, locale) });

  return (
    <PageGate page="broadcasts">
      <SectionCard
        id="broadcasts"
        title={t('title')}
        hint={t('hint')}
        actions={
          <ButtonLink href="/broadcasts/new" data-testid="broadcast-new">
            <PlusIcon aria-hidden />
            {t('new')}
          </ButtonLink>
        }
      >
        {list.isPending ? (
          <Skeleton className="h-32" />
        ) : list.isError ? null : list.data.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center">{t('empty')}</p>
        ) : (
          <ul className="divide-y" data-testid="broadcast-list">
            {list.data.map((b) => (
              <li key={b.id}>
                <Link
                  href={`/broadcasts/${b.id}`}
                  className="hover:bg-muted flex flex-col gap-1 rounded-md px-1 py-3"
                  data-testid="broadcast-row"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant={STATUS_VARIANT[b.status]}>{t(`status.${b.status}`)}</Badge>
                    <span className="text-muted-foreground text-sm">
                      {t(`recipients.${b.recipients}`)}
                    </span>
                  </span>
                  <span className="line-clamp-2 break-words whitespace-pre-line">{b.body}</span>
                  <span className="text-muted-foreground text-xs">
                    {b.status === 'SENT' && b.sentAt
                      ? `${t('sentAt', when(b.sentAt))} · ${t('counts', {
                          sent: formatCount(b.sms.sent, locale),
                          queued: formatCount(b.sms.queued, locale),
                          failed: formatCount(b.sms.failed, locale),
                        })}`
                      : b.status === 'SCHEDULED' && b.scheduledAt
                        ? t('scheduledFor', when(b.scheduledAt))
                        : null}
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

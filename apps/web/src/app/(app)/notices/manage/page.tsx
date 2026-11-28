'use client';

import { useQuery } from '@tanstack/react-query';
import { formatCount, formatDate, type NoticeManageItem, type NoticeState } from '@jantrik/shared';
import { PencilIcon, PlusIcon, SendIcon, Undo2Icon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { SectionCard } from '@/components/form-kit';
import { ContextGate } from '@/components/page-gate';
import { PublishDialog, WithdrawDialog } from '@/components/notices/notice-dialogs';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';
import { noticeKeys } from '@/lib/notices';

const STATE_VARIANT: Record<NoticeState, 'success' | 'info' | 'outline' | 'destructive'> = {
  DRAFT: 'outline',
  SCHEDULED: 'info',
  PUBLISHED: 'success',
  EXPIRED: 'outline',
  WITHDRAWN: 'destructive',
};

/** Notice management (OWNER/ADMIN, S20): every notice with its state, reads and actions. */
export default function NoticesManagePage() {
  const t = useTranslations('notices.manage');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const list = useQuery({
    queryKey: noticeKeys.manage(session?.tenant?.id),
    queryFn: () => client.api<NoticeManageItem[]>('/notices/manage'),
  });
  const [dialog, setDialog] = useState<{
    kind: 'publish' | 'withdraw';
    notice: NoticeManageItem;
  } | null>(null);

  return (
    <ContextGate allow={(c) => c.roles.includes('OWNER') || c.roles.includes('ADMIN')}>
      <SectionCard
        id="notices-manage"
        title={t('title')}
        hint={t('hint')}
        actions={
          <ButtonLink href="/notices/manage/new" data-testid="notice-new">
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
          <ul className="divide-y" data-testid="notice-manage-list">
            {list.data.map((n) => (
              <li
                key={n.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center"
                data-testid="notice-manage-row"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium break-words">{n.title}</span>
                    <Badge variant={STATE_VARIANT[n.state]}>{t(`state.${n.state}`)}</Badge>
                  </span>
                  <span className="text-muted-foreground flex flex-wrap gap-x-3 text-sm">
                    <span>{t(`audience.${n.audience}`)}</span>
                    <span>
                      {n.targets.length === 0
                        ? t('targetsAll')
                        : n.targets
                            .map(
                              (x) =>
                                `${(locale === 'bn' ? x.classNameBn : x.classNameEn) ?? ''}${x.sectionName ? ` ${x.sectionName}` : ''}`,
                            )
                            .join(', ')}
                    </span>
                    {n.publishAt && <span>{formatDate(n.publishAt, locale)}</span>}
                    <span>
                      {t('col.reads')}: {formatCount(n.readCount, locale)}
                    </span>
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {n.status !== 'WITHDRAWN' && (
                    <ButtonLink variant="outline" size="sm" href={`/notices/manage/${n.id}`}>
                      <PencilIcon aria-hidden />
                      {t('edit')}
                    </ButtonLink>
                  )}
                  {(n.state === 'DRAFT' || n.state === 'SCHEDULED') && (
                    <Button
                      size="sm"
                      onClick={() => setDialog({ kind: 'publish', notice: n })}
                      data-testid="notice-publish"
                    >
                      <SendIcon aria-hidden />
                      {t('publish')}
                    </Button>
                  )}
                  {n.status !== 'WITHDRAWN' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDialog({ kind: 'withdraw', notice: n })}
                    >
                      <Undo2Icon aria-hidden />
                      {t('withdraw')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      {dialog?.kind === 'publish' && (
        <PublishDialog notice={dialog.notice} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'withdraw' && (
        <WithdrawDialog notice={dialog.notice} onClose={() => setDialog(null)} />
      )}
    </ContextGate>
  );
}

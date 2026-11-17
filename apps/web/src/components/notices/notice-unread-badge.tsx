'use client';

import { formatCount } from '@jantrik/shared';
import { useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@/i18n/config';
import { useUnreadNotices } from '@/lib/notices';
import { cn } from '@/lib/utils';

/** The unread count beside "Notices" in the sidebar; nothing while loading or when zero. */
export function NoticeUnreadBadge({ active, collapsed }: { active: boolean; collapsed?: boolean }) {
  const t = useTranslations('shell');
  const locale = useLocale() as Locale;
  const { data } = useUnreadNotices(true);
  const count = data?.count ?? 0;
  if (count <= 0) return null;
  return (
    <span
      data-testid="notices-unread"
      aria-label={t('unreadNotices', { count: formatCount(count, locale) })}
      className={cn(
        'min-w-5 rounded-full px-1.5 text-center text-xs leading-5 font-semibold',
        active ? 'bg-sidebar-primary-foreground text-sidebar-primary' : 'bg-primary text-primary-foreground',
        collapsed && 'absolute -end-0.5 -top-0.5 min-w-4 px-1 text-[10px] leading-4',
      )}
    >
      {formatCount(count, locale)}
    </span>
  );
}

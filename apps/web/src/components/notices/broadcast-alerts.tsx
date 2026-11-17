'use client';

import { useQuery } from '@tanstack/react-query';
import { formatDate, type BroadcastAlert } from '@jantrik/shared';
import { TriangleAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@/i18n/config';
import { useAuth } from '@/lib/auth/auth-provider';

/**
 * OWNER/ADMIN dashboard warning (S18 "told in-app", P6-D): a broadcast that failed over the cap
 * or was cancelled because its admin lost the role in the last 3 days, or one overdue.
 */
export function BroadcastAlerts() {
  const t = useTranslations('notices.broadcasts');
  const locale = useLocale() as Locale;
  const { client, session } = useAuth();
  const alerts = useQuery({
    queryKey: ['broadcasts', session?.tenant?.id, 'alerts'],
    queryFn: () => client.api<BroadcastAlert[]>('/broadcasts/alerts'),
  });
  if (!alerts.data?.length) return null;
  return (
    <section
      role="alert"
      className="border-warning/40 bg-warning-soft flex flex-col gap-2 rounded-xl border p-4"
      data-testid="broadcast-alerts"
    >
      <h2 className="flex items-center gap-2 font-semibold">
        <TriangleAlertIcon aria-hidden className="text-warning size-4.5" />
        {t('alertsTitle')}
      </h2>
      <ul className="flex flex-col gap-1 text-sm">
        {alerts.data.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-x-2">
            <span>{t(`alert.${a.status}`)}</span>
            <span className="text-muted-foreground">
              “{a.bodyStart}” · {formatDate(a.at, locale)}
            </span>
            <Link
              href={`/broadcasts/${a.id}`}
              className="text-link underline-offset-4 hover:underline"
            >
              {t('alertOpen')}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

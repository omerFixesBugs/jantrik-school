'use client';

import { formatCount, type DeviceAlert } from '@jantrik/shared';
import { RouterIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { ButtonLink } from '@/components/ui/button';
import type { Locale } from '@/i18n/config';
import { cn } from '@/lib/utils';
import { useAlertText } from './alert-text';

/** Lines shown; the rest is "N more". */
const SHOWN = 3;

/**
 * The device alerts on the dashboard, in the held-SMS banner's style: how many, the worst few in
 * the API's order (offline first), and the way to the devices screen.
 */
export default function DeviceAlertsCard({ alerts }: { alerts: DeviceAlert[] }) {
  const t = useTranslations('devices.devices.dashboard');
  const locale = useLocale() as Locale;
  const text = useAlertText();
  const now = new Date();
  const lines = alerts.map((a) => text(a, now));
  const urgent = lines[0]!.tone === 'destructive';
  const rest = alerts.length - SHOWN;
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between',
        urgent ? 'border-destructive/30 bg-destructive-soft' : 'border-warning/40 bg-warning-soft',
      )}
      data-testid="device-alerts-card"
    >
      <div className="flex min-w-0 gap-3">
        <RouterIcon
          aria-hidden
          className={cn('mt-0.5 size-5 shrink-0', urgent ? 'text-destructive' : 'text-warning')}
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">
            {t('title', { count: formatCount(alerts.length, locale), n: alerts.length })}
          </span>
          <ul className="text-muted-foreground text-sm">
            {lines.slice(0, SHOWN).map((line, i) => (
              <li key={i} className="break-words">
                {line.title}
              </li>
            ))}
            {rest > 0 && <li>{t('more', { count: formatCount(rest, locale) })}</li>}
          </ul>
        </div>
      </div>
      <ButtonLink variant="outline" className="shrink-0" href="/attendance/devices">
        {t('open')}
      </ButtonLink>
    </div>
  );
}

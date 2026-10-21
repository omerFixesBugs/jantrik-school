'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/*
 * Dashboard figures (docs/design.md → Dashboards): the name, the number in tabular figures, what
 * it is measured against, and its recent history as a chalk sparkline or a meter. Real numbers
 * only: "—" until there is one, and a module that is not running yet gets a dashed KpiPlaceholder
 * that says what will appear.
 */

export function KpiTile({
  label,
  value,
  hint,
  chart,
  meter,
  href,
  loading,
  failed,
  testId,
  className,
}: {
  label: string;
  /** The figure, formatted; null when there is nothing to show yet. */
  value: ReactNode | null;
  hint?: ReactNode;
  /** A sparkline beside the figure. */
  chart?: ReactNode;
  /** A meter under the figure. */
  meter?: ReactNode;
  href?: string;
  loading?: boolean;
  /** The figure could not be loaded (says so, instead of "not started yet"). */
  failed?: boolean;
  testId?: string;
  className?: string;
}) {
  const t = useTranslations('dashboard');
  const body = (
    <>
      <span className="flex items-start justify-between gap-2">
        <span className="text-muted-foreground text-sm font-medium">{label}</span>
        {chart && !loading && !failed && (
          <span className="flex min-w-0 flex-1 justify-end pt-0.5">{chart}</span>
        )}
      </span>
      {loading ? (
        <Skeleton className="h-9 w-24" />
      ) : (
        // A big school's "১,০২৩ / ১,১০০" wraps at the slash rather than overflowing the tile.
        <span className="font-numeric text-3xl leading-tight font-semibold">
          {failed || value === null ? (
            <>
              <span aria-hidden>—</span>
              {!failed && <span className="sr-only">{t('notYet')}</span>}
            </>
          ) : (
            value
          )}
        </span>
      )}
      {meter}
      {(failed || hint) && (
        <span className="text-muted-foreground text-sm leading-snug">
          {failed ? t('loadFailed') : hint}
        </span>
      )}
    </>
  );
  const box = 'bg-card flex h-full flex-col gap-2 rounded-lg border p-(--panel-p)';
  return (
    <li data-testid={testId} className={className}>
      {href ? (
        <Link
          href={href}
          className={cn(
            box,
            'hover:border-primary/50 focus-visible:ring-ring transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
          )}
        >
          {body}
        </Link>
      ) : (
        <div className={box}>{body}</div>
      )}
    </li>
  );
}

/** A module that is not running yet: what will appear here, never a made-up number. */
export function KpiPlaceholder({
  label,
  hint,
  testId,
}: {
  label: string;
  hint: string;
  testId?: string;
}) {
  return (
    <li
      data-testid={testId}
      className="border-input flex flex-col gap-0.5 rounded-lg border border-dashed px-(--panel-p) py-2.5"
    >
      <span className="text-muted-foreground text-sm font-medium">{label}</span>
      <span className="text-muted-foreground text-sm">{hint}</span>
    </li>
  );
}

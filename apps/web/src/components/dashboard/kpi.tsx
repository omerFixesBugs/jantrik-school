'use client';

import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useCountUp } from '@/lib/use-count-up';
import { cn } from '@/lib/utils';

/*
 * Dashboard figures (docs/design.md → Dashboards): a floating card with the name and an icon chip,
 * the number big and light, how it moved against the comparison period (a delta pill and what it
 * is compared with), and its recent history as a mini chart or a gauge. Real numbers only: "—"
 * until there is one, and a module that is not running yet gets a dashed KpiPlaceholder that
 * says what will appear.
 */

/**
 * The figure counting up to its value. The final text holds the width from the first frame (so
 * nothing beside it moves), and is what screen readers get.
 */
function CountUp({ to, format }: { to: number; format: (n: number) => string }) {
  const [ref, value] = useCountUp<HTMLSpanElement>(to);
  return (
    <>
      <span aria-hidden className="inline-grid">
        <span className="invisible col-start-1 row-start-1">{format(to)}</span>
        <span ref={ref} className="col-start-1 row-start-1">
          {format(value === to ? to : Math.round(value))}
        </span>
      </span>
      <span className="sr-only">{format(to)}</span>
    </>
  );
}

export function KpiTile({
  label,
  icon: Icon,
  value,
  count,
  suffix,
  delta,
  compare,
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
  icon?: LucideIcon;
  /** The figure, formatted; null when there is nothing to show yet. */
  value?: ReactNode | null;
  /** The figure as a number that counts up when it first comes into view (instead of `value`). */
  count?: { to: number; format: (n: number) => string } | null;
  /** After the figure, smaller ("/ ২৭"). */
  suffix?: ReactNode;
  /** How it moved: a DeltaPill. */
  delta?: ReactNode;
  /** What the delta is against ("গত সপ্তাহের তুলনায়"). */
  compare?: string;
  hint?: ReactNode;
  /** A mini chart beside the label. */
  chart?: ReactNode;
  /** A meter or gauge under the figure. */
  meter?: ReactNode;
  href?: string;
  loading?: boolean;
  /** The figure could not be loaded (says so, instead of "not started yet"). */
  failed?: boolean;
  testId?: string;
  className?: string;
}) {
  const t = useTranslations('dashboard');
  const empty = failed || (count == null && (value === null || value === undefined));
  const body = (
    <>
      <span className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2.5">
          {Icon && (
            <span className="bg-primary-soft text-primary-ink flex size-9 shrink-0 items-center justify-center rounded-xl">
              <Icon aria-hidden className="size-4.5" />
            </span>
          )}
          <span className="text-muted-foreground text-sm font-medium">{label}</span>
        </span>
        {chart && !loading && !failed && (
          <span className="flex min-w-0 flex-1 justify-end pt-0.5">{chart}</span>
        )}
      </span>
      {loading ? (
        <Skeleton className="h-10 w-28" />
      ) : (
        // Big and light (Noto's figures are drawn for weight 300). A big school's
        // "১,০২৩ / ১,১০০" wraps at the suffix rather than overflowing the tile.
        <span className="font-numeric flex flex-wrap items-baseline gap-x-1.5 leading-none">
          <span className="text-[2.25rem] font-light sm:text-[2.5rem]">
            {empty ? (
              <>
                <span aria-hidden>—</span>
                {!failed && <span className="sr-only">{t('notYet')}</span>}
              </>
            ) : count ? (
              <CountUp to={count.to} format={count.format} />
            ) : (
              value
            )}
          </span>
          {!empty && suffix && (
            <span className="text-muted-foreground text-lg font-normal">{suffix}</span>
          )}
        </span>
      )}
      {!loading && !failed && (delta || compare) && (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {delta}
          {compare && <span className="text-muted-foreground text-xs">{compare}</span>}
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
  const box =
    'bg-card rounded-card shadow-card flex h-full flex-col gap-3 border p-(--panel-p) text-start';
  return (
    <li data-testid={testId} className={className}>
      {href ? (
        <Link
          data-slot="card"
          href={href}
          className={cn(
            box,
            'lift focus-visible:ring-ring outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
          )}
        >
          {body}
        </Link>
      ) : (
        <div data-slot="card" className={box}>
          {body}
        </div>
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
      className="border-input rounded-card flex flex-col gap-0.5 border border-dashed px-(--panel-p) py-3"
    >
      <span className="text-muted-foreground text-sm font-medium">{label}</span>
      <span className="text-muted-foreground text-sm">{hint}</span>
    </li>
  );
}

'use client';

import { arcPath, donutSlices } from '@jantrik/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { cn } from '@/lib/utils';

/*
 * The dashboard's story charts (docs/design.md → Components; the dataviz rules), our own SVG and
 * CSS: hatched columns with one highlighted, a half gauge, a donut with the total in the middle.
 * Each carries its numbers as text (direct labels, or a list screen readers read), never colour
 * alone. Colours are tokens; numbers are formatted by the caller.
 */

export interface ColumnItem {
  key: string;
  /** Under the column ("রবি"); also what screen readers hear with the value. */
  label: string;
  value: number | null;
  /** The value as text ("৯৬%"). */
  display: string;
}

/**
 * Columns over a few periods (this week's school days): history hatched in a mid-tone (3:1 on the
 * card), the one that matters (today) solid in the accent, with its value above it unless the
 * chart is `decorative` (a KPI tile's mini chart, whose text already says the numbers). A
 * missing day (holiday, not taken) is a short dashed stub.
 */
export function HatchedColumns({
  items,
  highlight,
  max = 100,
  height = 64,
  title,
  showLabels = false,
  decorative = false,
  className,
}: {
  items: readonly ColumnItem[];
  highlight?: string | null;
  max?: number;
  height?: number;
  title: string;
  showLabels?: boolean;
  decorative?: boolean;
  className?: string;
}) {
  return (
    <ul
      aria-label={decorative ? undefined : title}
      aria-hidden={decorative || undefined}
      className={cn('flex items-end gap-1.5', className)}
    >
      {items.map((item) => {
        const on = item.key === highlight;
        const share = item.value === null || max <= 0 ? 0 : Math.min(1, item.value / max);
        return (
          <li
            key={item.key}
            aria-current={on ? 'true' : undefined}
            className="flex min-w-0 flex-1 flex-col items-center gap-1"
          >
            {!decorative && (
              <span
                aria-hidden
                className={cn(
                  'font-numeric text-xs leading-4 font-semibold',
                  on ? 'text-foreground' : 'invisible',
                )}
              >
                {item.display}
              </span>
            )}
            <span className="flex w-full justify-center" style={{ height }}>
              <span className="flex h-full w-full max-w-4 flex-col justify-end">
                {item.value === null ? (
                  <span className="border-input h-1.5 w-full rounded-full border border-dashed" />
                ) : (
                  <span
                    className={cn(
                      'w-full rounded-full',
                      on ? 'bg-primary' : 'hatch bg-input text-card',
                    )}
                    // A true zero is a hairline on the baseline, not a short bar.
                    style={{ height: share > 0 ? `${Math.max(6, share * 100)}%` : '2px' }}
                  />
                )}
              </span>
            </span>
            {showLabels && (
              <span
                aria-hidden
                className={cn(
                  'text-xs',
                  on ? 'text-foreground font-semibold' : 'text-muted-foreground',
                )}
              >
                {item.label}
              </span>
            )}
            {!decorative && (
              <span className="sr-only">
                {item.label}: {item.value === null ? '—' : item.display}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A part of a whole on a half circle (registers taken today, SMS against the cap): the track,
 * the filled share in the accent (or warning), and the figure under the arc.
 */
export function HalfGauge({
  value,
  max,
  display,
  label,
  size = 112,
  tone = 'accent',
  className,
}: {
  value: number;
  max: number;
  /** In the middle ("১/৪"). */
  display: string;
  /** The meter's name and spoken value, e.g. "৪টি শাখার ১টির হাজিরা নেওয়া হয়েছে". */
  label: string;
  size?: number;
  tone?: 'accent' | 'warning';
  className?: string;
}) {
  const stroke = 10;
  const r = size / 2 - stroke / 2 - 1;
  const c = size / 2;
  const share = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  // Room for the round caps at both ends of the arc.
  const h = c + stroke / 2 + 1;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(Math.max(0, value), max)}
      aria-valuetext={label}
      className={cn('relative shrink-0', className)}
      style={{ width: size, height: h }}
    >
      <svg width={size} height={h} aria-hidden>
        <path
          d={arcPath(c, c, r, -90, 90)}
          fill="none"
          stroke="var(--border)"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        {share > 0 && (
          <path
            d={arcPath(c, c, r, -90, -90 + 180 * share)}
            fill="none"
            stroke={tone === 'warning' ? 'var(--warning)' : 'var(--primary)'}
            strokeWidth={stroke}
            strokeLinecap="round"
          />
        )}
      </svg>
      <span
        aria-hidden
        className="font-numeric absolute inset-x-0 bottom-0 text-center text-base leading-none font-semibold"
      >
        {display}
      </span>
    </div>
  );
}

export interface DonutItem {
  key: string;
  label: string;
  value: number;
  /** The value as text ("১২ জন"). */
  display: string;
}

const SERIES = 5;

/**
 * A whole split into a few parts (students by class): a ring with the total in the middle and a
 * label for every part (its count and share). Parts keep the order given (class order) and the
 * series colours in their fixed order, so a colour always means the same part; past five, the
 * rest fold into "other". Pointing at a part (on the ring or its label) brings it forward.
 */
export function Donut({
  items,
  total,
  title,
  formatShare,
  formatOther,
  size = 148,
  className,
}: {
  items: readonly DonutItem[];
  total: { display: string; label: string };
  title: string;
  formatShare: (share: number) => string;
  /** The folded remainder as text ("৩ জন"). */
  formatOther: (value: number) => string;
  size?: number;
  className?: string;
}) {
  const t = useTranslations('charts');
  const [active, setActive] = useState<string | null>(null);
  const parts =
    items.length <= SERIES
      ? items
      : [
          ...items.slice(0, SERIES - 1),
          (() => {
            const rest = items.slice(SERIES - 1).reduce((sum, i) => sum + i.value, 0);
            return { key: '~other', label: t('other'), value: rest, display: formatOther(rest) };
          })(),
        ];
  const stroke = 18;
  const r = size / 2 - stroke / 2 - 1;
  const c = size / 2;
  // A 2 px surface gap between neighbours, as an angle on this ring.
  const gap = (2 / (2 * Math.PI * r)) * 360;
  const slices = donutSlices(
    parts.map((p) => p.value),
    gap,
  );
  return (
    <div className={cn('flex flex-wrap items-center gap-x-6 gap-y-4', className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} aria-hidden className="overflow-visible">
          <circle cx={c} cy={c} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
          {slices.map((s, i) =>
            s.share > 0 ? (
              <path
                key={parts[i]!.key}
                d={arcPath(c, c, r, s.start, s.end)}
                fill="none"
                stroke={`var(--chart-${i + 1})`}
                strokeWidth={stroke}
                className="transition-opacity"
                opacity={active && active !== parts[i]!.key ? 0.3 : 1}
                onPointerEnter={() => setActive(parts[i]!.key)}
                onPointerLeave={() => setActive(null)}
              />
            ) : null,
          )}
        </svg>
        <span
          aria-hidden
          className="absolute inset-0 flex flex-col items-center justify-center text-center"
        >
          <span className="font-numeric text-2xl leading-none font-light">{total.display}</span>
          <span className="text-muted-foreground mt-1 text-xs">{total.label}</span>
        </span>
      </div>
      <ul aria-label={title} className="flex min-w-40 flex-1 flex-col gap-1.5">
        <li className="sr-only">
          {total.label}: {total.display}
        </li>
        {parts.map((p, i) => (
          <li
            key={p.key}
            onPointerEnter={() => setActive(p.key)}
            onPointerLeave={() => setActive(null)}
            className={cn(
              'flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm transition-opacity',
              active && active !== p.key && 'opacity-60',
            )}
          >
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: `var(--chart-${i + 1})` }}
            />
            <span className="min-w-0 flex-1 truncate">{p.label}</span>
            <span className="num font-medium">{p.display}</span>
            <span className="num text-muted-foreground w-12">
              {formatShare(slices[i]?.share ?? 0)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

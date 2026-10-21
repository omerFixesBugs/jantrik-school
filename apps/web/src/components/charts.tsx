'use client';

import {
  indexOfMin,
  linearScale,
  monotoneArea,
  monotonePath,
  niceTicks,
  percentDomain,
} from '@jantrik/shared';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useId,
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';

/*
 * Our own small SVG charts (docs/design.md → Components; the dataviz rules): 2 px lines, a soft
 * gradient wash, ≥ 8 px end dots with a 2 px surface ring, solid hairline grids, one axis,
 * selective labels (the end and the lowest point), a crosshair tooltip on pointer and keyboard,
 * and a table view for every chart. Colours come from tokens; numbers are formatted by the caller.
 */

/** `accent`: the theme's accent ink (follows an owner's accent); the others are fixed inks. */
export type Tone = 'accent' | 'mint' | 'sky' | 'orange' | 'pink';
export const toneInk = (tone: Tone) =>
  tone === 'accent' ? 'var(--primary-ink)' : `var(--chalk-${tone}-ink)`;

/**
 * Width of an element, kept up to date (charts draw in real pixels so text stays crisp). A
 * callback ref, so a remounted element (table view → chart view) is observed again.
 */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.round(entry!.contentRect.width)),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width];
}

// ─────────────────────────── Sparkline ───────────────────────────

/**
 * A KPI's recent history: the line in the de-emphasis ink, the latest point in the accent. Gaps
 * (null) break the line. Decorative: the tile's own text carries the numbers.
 */
export function Sparkline({
  values,
  className,
  tone = 'accent',
}: {
  values: readonly (number | null)[];
  className?: string;
  tone?: Tone;
}) {
  const w = 120;
  const h = 32;
  const real = values.filter((v): v is number => v !== null);
  if (real.length < 2) return null;
  const min = Math.min(...real);
  const max = Math.max(...real);
  const x = linearScale([0, values.length - 1], [3, w - 3]);
  const y = linearScale(min === max ? [min - 1, max + 1] : [min, max], [h - 4, 4]);
  const segments: string[] = [];
  let open = false;
  values.forEach((v, i) => {
    if (v === null) {
      open = false;
      return;
    }
    segments.push(`${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    open = true;
  });
  const lastIndex = values.findLastIndex((v) => v !== null);
  const last = values[lastIndex]!;
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${w} ${h}`}
      className={cn('h-8 w-28 overflow-visible', className)}
      preserveAspectRatio="none"
    >
      <path
        d={segments.join(' ')}
        fill="none"
        stroke="var(--muted-foreground)"
        strokeOpacity={0.55}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={x(lastIndex)}
        cy={y(last)}
        r={3}
        fill={toneInk(tone)}
        stroke="var(--card)"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

// ─────────────────────────── Meter ───────────────────────────

/** A part of a whole against a limit (registers taken, SMS against the cap). */
export function Meter({
  value,
  max,
  label,
  className,
  tone = 'board',
}: {
  value: number;
  max: number;
  /** The meter's name and spoken value, e.g. "১৩ / ১৫ শাখা". */
  label: string;
  className?: string;
  tone?: 'board' | 'warning';
}) {
  const share = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(Math.max(0, value), max)}
      aria-valuetext={label}
      className={cn('bg-primary-soft h-1.5 w-full overflow-hidden rounded-full', className)}
    >
      <div
        className={cn('h-full rounded-full', tone === 'warning' ? 'bg-warning' : 'bg-primary')}
        style={{ width: `${share * 100}%` }}
      />
    </div>
  );
}

// ─────────────────────────── Trend chart ───────────────────────────

export interface TrendPoint {
  /** What the x position is (an ISO date): the key for the tooltip and the table. */
  key: string;
  value: number | null;
  /** Under the value in the tooltip and in the table, e.g. "৫৭৭ / ৬১২ জন". */
  detail?: string;
  /** A reason there is no value (a holiday): shown instead of "—". */
  note?: string;
}

/**
 * One series over time (present % by school day): a smooth line that never invents a high or a
 * low between two days, a soft gradient wash under it, the lowest and the last point labelled,
 * a crosshair that snaps to the nearest day with a floating tooltip, and a table view. Days
 * without a value are gaps, never zeros; a lone day between gaps is a dot.
 *
 * Optionally the same days of the previous period as a dashed ghost line, and a labelled target
 * line (the 90 % the school aims for); with either, a small legend names the lines.
 */
export function TrendChart({
  points,
  formatValue,
  formatKey,
  formatAxis,
  title,
  height = 180,
  domain,
  tone = 'accent',
  previous,
  target,
  currentLabel,
  className,
}: {
  points: readonly TrendPoint[];
  formatValue: (value: number) => string;
  /** Long form for the tooltip and table ("বুধবার, ২১ অক্টোবর"). */
  formatKey: (key: string) => string;
  /** Short form under the axis ("২১ অক্টো"). */
  formatAxis: (key: string) => string;
  /** Names the chart for screen readers and the table caption. */
  title: string;
  height?: number;
  domain?: [number, number];
  tone?: Tone;
  /** The previous period's value at each point (same length), drawn as a dashed ghost. */
  previous?: { values: readonly (number | null)[]; label: string };
  target?: { value: number; label: string };
  /** Names this period's line in the legend (shown when there is a ghost or a target). */
  currentLabel?: string;
  className?: string;
}) {
  const t = useTranslations('charts');
  const gradient = `trend-${useId().replace(/:/g, '')}`;
  const [box, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const values = points.map((p) => p.value);
  const ghost = previous?.values ?? [];
  // The ghost and the target always fit, even inside a caller's own range.
  const extra = [...ghost, ...(target ? [target.value] : [])].filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  const base = domain ?? percentDomain([...values, ...extra]);
  const d0 = extra.length ? Math.min(base[0], percentDomain(extra)[0]) : base[0];
  const d1 = base[1];
  const named = target ? `${title}. ${target.label}` : title;
  const ticks = niceTicks(d0, d1, 4);
  const lastIndex = values.findLastIndex((v) => v !== null);
  // The y labels and the last point's label are measured once drawn ("১০০%" is wider in Bangla
  // and in the comfortable density): the plot leaves just the room they need on either side.
  const endText = lastIndex >= 0 ? formatValue(values[lastIndex]!) : '';
  const measureKey = `${ticks.map(formatValue).join('|')}|${endText}@${width}`;
  const [labelW, setLabelW] = useState({ axis: 0, end: 0 });
  const measureLabels = useCallback(
    (svg: SVGSVGElement | null) => {
      if (!svg) return;
      const widest = (selector: string) => {
        let max = 0;
        svg.querySelectorAll<SVGTextElement>(selector).forEach((el) => {
          // Never less than the characters would need at this size: before the web font
          // arrives, the fallback face measures narrower than what is drawn a moment later.
          const size = parseFloat(getComputedStyle(el).fontSize) || 12;
          const floor = (el.textContent?.length ?? 0) * size * 0.68;
          max = Math.max(max, el.getComputedTextLength(), floor);
        });
        return Math.ceil(max);
      };
      const measure = () => {
        const next = { axis: widest('[data-axis-label]'), end: widest('[data-end-label]') };
        setLabelW((w) =>
          Math.abs(w.axis - next.axis) < 1 && Math.abs(w.end - next.end) < 1 ? w : next,
        );
      };
      measure();
      void document.fonts?.ready.then(measure);
      document.fonts?.addEventListener('loadingdone', measure);
      return () => document.fonts?.removeEventListener('loadingdone', measure);
    },
    // A new callback (and a new measurement) whenever the labels or the width change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [measureKey],
  );
  const pad = {
    top: 18,
    // The last point's label starts 8 px after it.
    right: Math.max(44, labelW.end + 14),
    bottom: 24,
    left: Math.max(36, labelW.axis + 12),
  };
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const x = linearScale([0, Math.max(1, points.length - 1)], [pad.left, pad.left + plotW]);
  const y = linearScale([d0, d1], [pad.top + plotH, pad.top]);
  const real = values.filter((v): v is number => v !== null);
  // A flat series has no "lowest" worth a label.
  const lowest =
    real.length > 1 && Math.min(...real) !== Math.max(...real) ? indexOfMin(values) : -1;
  const stroke = toneInk(tone);

  // The curve and its wash through the days with a value; gaps (null) split both.
  const at = (v: number | null | undefined, i: number) =>
    v === null || v === undefined ? null : { x: x(i), y: y(v) };
  const line = monotonePath(values.map(at));
  const area = monotoneArea(values.map(at), y(d0));
  const ghostLine = ghost.length ? monotonePath(ghost.map(at)) : '';
  // A lone day between gaps has no line to sit on: a dot.
  const lonely = values
    .map((v, i) => ({ v, i }))
    .filter(({ v, i }) => v !== null && values[i - 1] == null && values[i + 1] == null) as {
    v: number;
    i: number;
  }[];

  // x labels: the first, the last, and every step in between, never crowding the last.
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 84))));
  const lastKey = points.length - 1;
  const xLabels = points
    .map((_, i) => i)
    .filter((i) => i === 0 || i === lastKey || (i % labelEvery === 0 && lastKey - i >= labelEvery));

  const nearest = (clientX: number, rect: DOMRect) => {
    const px = clientX - rect.left;
    const i = Math.round(((px - pad.left) / Math.max(1, plotW)) * (points.length - 1));
    return Math.min(points.length - 1, Math.max(0, i));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (lastIndex < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const from = active ?? lastIndex;
      const step = e.key === 'ArrowRight' ? 1 : -1;
      setActive(Math.min(points.length - 1, Math.max(0, from + step)));
    } else if (e.key === 'Escape') setActive(null);
  };

  const tip = active !== null && lastIndex >= 0 ? points[active] : null;
  const tipGhost = active !== null ? ghost[active] : undefined;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
        {(previous || target) && (
          <ul aria-hidden className="text-muted-foreground me-auto flex flex-wrap gap-x-4 text-xs">
            {currentLabel && (
              <li className="flex items-center gap-1.5">
                <svg width="16" height="8" aria-hidden>
                  <line x1="1" x2="15" y1="4" y2="4" stroke={stroke} strokeWidth={2} />
                </svg>
                {currentLabel}
              </li>
            )}
            {previous && (
              <li className="flex items-center gap-1.5">
                <svg width="16" height="8" aria-hidden>
                  <line
                    x1="1"
                    x2="15"
                    y1="4"
                    y2="4"
                    stroke="var(--muted-foreground)"
                    strokeWidth={2}
                    strokeDasharray="3 3"
                  />
                </svg>
                {previous.label}
              </li>
            )}
            {target && (
              <li className="flex items-center gap-1.5">
                <svg width="16" height="8" aria-hidden>
                  <line
                    x1="1"
                    x2="15"
                    y1="4"
                    y2="4"
                    stroke="var(--foreground)"
                    strokeOpacity={0.55}
                    strokeDasharray="1 3"
                    strokeLinecap="round"
                  />
                </svg>
                {target.label}
              </li>
            )}
          </ul>
        )}
        <button
          type="button"
          className="text-link min-h-(--control-h-xs) text-xs underline-offset-2 hover:underline"
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable ? t('showChart') : t('showTable')}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-72 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <caption className="sr-only">{named}</caption>
            <thead className="bg-muted sticky top-0">
              <tr>
                <th scope="col" className="px-3 py-1.5 text-start font-medium">
                  {t('day')}
                </th>
                <th scope="col" className="num px-3 py-1.5 font-medium">
                  {t('value')}
                </th>
                {previous && (
                  <th scope="col" className="num px-3 py-1.5 font-medium">
                    {previous.label}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={p.key} className="border-t">
                  <td className="px-3 py-1.5">{formatKey(p.key)}</td>
                  <td className="num px-3 py-1.5">
                    {p.value === null ? (p.note ?? '—') : formatValue(p.value)}
                    {p.detail && <span className="text-muted-foreground ms-2">{p.detail}</span>}
                  </td>
                  {previous && (
                    <td className="num px-3 py-1.5">
                      {ghost[i] == null ? '—' : formatValue(ghost[i]!)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={box} className="relative w-full" style={{ height }} dir="ltr">
          {width > 0 && (
            <svg
              ref={measureLabels}
              width={width}
              height={height}
              role="img"
              aria-label={named}
              tabIndex={0}
              className="focus-visible:ring-ring rounded-md outline-none focus-visible:ring-2"
              onPointerMove={(e) => {
                if (lastIndex >= 0)
                  setActive(nearest(e.clientX, e.currentTarget.getBoundingClientRect()));
              }}
              onPointerLeave={() => setActive(null)}
              onFocus={() => setActive((a) => a ?? (lastIndex >= 0 ? lastIndex : null))}
              onBlur={() => setActive(null)}
              onKeyDown={onKey}
            >
              <g>
                {ticks.map((v) => (
                  <g key={v}>
                    <line
                      x1={pad.left}
                      x2={pad.left + plotW}
                      y1={y(v)}
                      y2={y(v)}
                      stroke="var(--border)"
                    />
                    <text
                      data-axis-label
                      x={pad.left - 6}
                      y={y(v)}
                      dy="0.32em"
                      textAnchor="end"
                      className="fill-muted-foreground text-xs"
                    >
                      {formatValue(v)}
                    </text>
                  </g>
                ))}
              </g>
              {xLabels.map((i) => (
                <text
                  key={points[i]!.key}
                  x={x(i)}
                  y={height - 6}
                  textAnchor={i === 0 ? 'start' : i === lastKey ? 'end' : 'middle'}
                  className="fill-muted-foreground text-xs"
                >
                  {formatAxis(points[i]!.key)}
                </text>
              ))}
              <defs>
                <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor={stroke} stopOpacity={0.22} />
                  <stop offset="1" stopColor={stroke} stopOpacity={0} />
                </linearGradient>
              </defs>
              <path d={area} fill={`url(#${gradient})`} />
              {target && (
                <g>
                  <line
                    x1={pad.left}
                    x2={pad.left + plotW}
                    y1={y(target.value)}
                    y2={y(target.value)}
                    stroke="var(--foreground)"
                    strokeOpacity={0.55}
                    strokeDasharray="1 4"
                    strokeLinecap="round"
                  />
                </g>
              )}
              {ghostLine && (
                <path
                  d={ghostLine}
                  fill="none"
                  stroke="var(--muted-foreground)"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  strokeLinecap="round"
                />
              )}
              <path
                d={line}
                pathLength={1}
                className="draw-in"
                fill="none"
                stroke={stroke}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {lonely.map((p) => (
                <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={3} fill={stroke} />
              ))}
              {lowest >= 0 && lowest !== lastIndex && (
                <g>
                  <circle
                    cx={x(lowest)}
                    cy={y(values[lowest]!)}
                    r={4}
                    fill="var(--destructive)"
                    stroke="var(--card)"
                    strokeWidth={2}
                  />
                  <text
                    x={x(lowest)}
                    // Under the point, unless that would reach the dates under the plot.
                    y={
                      y(values[lowest]!) + 18 <= pad.top + plotH - 2
                        ? y(values[lowest]!) + 18
                        : y(values[lowest]!) - 10
                    }
                    // Near either end the label runs inward, clear of the edge and the end label.
                    textAnchor={
                      x(lowest) > pad.left + plotW - 64
                        ? 'end'
                        : x(lowest) < pad.left + 64
                          ? 'start'
                          : 'middle'
                    }
                    className="fill-foreground text-xs font-medium"
                  >
                    {t('lowest', { value: formatValue(values[lowest]!) })}
                  </text>
                </g>
              )}
              {lastIndex >= 0 && (
                <g>
                  <circle
                    cx={x(lastIndex)}
                    cy={y(values[lastIndex]!)}
                    r={4}
                    fill={stroke}
                    stroke="var(--card)"
                    strokeWidth={2}
                  />
                  <text
                    data-end-label
                    x={x(lastIndex) + 8}
                    y={y(values[lastIndex]!)}
                    dy="0.32em"
                    className="fill-foreground text-xs font-semibold"
                  >
                    {formatValue(values[lastIndex]!)}
                  </text>
                </g>
              )}
              {active !== null && lastIndex >= 0 && (
                <g>
                  <line
                    x1={x(active)}
                    x2={x(active)}
                    y1={pad.top}
                    y2={pad.top + plotH}
                    stroke="var(--muted-foreground)"
                    strokeOpacity={0.6}
                  />
                  {values[active] != null && (
                    <circle
                      cx={x(active)}
                      cy={y(values[active]!)}
                      r={5}
                      fill={stroke}
                      stroke="var(--card)"
                      strokeWidth={2}
                    />
                  )}
                </g>
              )}
            </svg>
          )}
          {tip && width > 0 && (
            <Tooltip x={x(active!)} width={width}>
              <span className="font-numeric text-sm font-semibold">
                {tip.value === null ? (tip.note ?? '—') : formatValue(tip.value)}
              </span>
              {tip.detail && <span className="text-muted-foreground text-xs">{tip.detail}</span>}
              {previous && tipGhost != null && (
                <span className="text-muted-foreground text-xs">
                  {previous.label}: {formatValue(tipGhost)}
                </span>
              )}
              <span className="text-muted-foreground text-xs">{formatKey(tip.key)}</span>
            </Tooltip>
          )}
          <p className="sr-only" aria-live="polite">
            {tip
              ? `${formatKey(tip.key)}: ${tip.value === null ? (tip.note ?? '—') : formatValue(tip.value)}` +
                (previous && tipGhost != null
                  ? `; ${previous.label}: ${formatValue(tipGhost)}`
                  : '')
              : ''}
          </p>
        </div>
      )}
    </div>
  );
}

/** The floating tooltip beside the crosshair (also used by the story charts). */
export function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  // Kept inside the chart: flips to the left of the crosshair near the right edge.
  const right = x > width - 170;
  return (
    <div
      aria-hidden
      className="bg-popover text-popover-foreground shadow-card pointer-events-none absolute top-0 z-10 flex min-w-32 flex-col gap-0.5 rounded-xl border px-3 py-2"
      style={right ? { right: width - x + 12 } : { left: x + 12 }}
    >
      {children}
    </div>
  );
}

// ─────────────────────────── Bar list ───────────────────────────

export interface BarItem {
  key: string;
  label: string;
  value: number | null;
  /** The value as text (at the bar's tip). */
  display: string;
}

/**
 * Categories compared by one measure (present % by class): horizontal bars from one baseline,
 * 12 px thick with a 4 px rounded end, the value at the tip. Choosing one brightens it and dims
 * the rest; `onSelect` makes rows buttons.
 */
export function BarList({
  items,
  max,
  selected,
  onSelect,
  title,
  tone = 'accent',
}: {
  items: readonly BarItem[];
  max: number;
  selected?: string | null;
  onSelect?: (key: string | null) => void;
  title: string;
  tone?: Tone;
}) {
  return (
    <ul aria-label={title} className="flex flex-col gap-1.5">
      {items.map((item) => {
        const share = item.value === null || max <= 0 ? 0 : Math.min(1, item.value / max);
        const dim = selected != null && selected !== item.key;
        const row = (
          <>
            <span className="truncate text-sm">{item.label}</span>
            <span className="bg-muted relative h-3 overflow-hidden rounded-e-[4px]">
              <span
                className={cn(
                  'absolute inset-y-0 start-0 rounded-e-[4px] transition-opacity',
                  dim && 'opacity-30',
                )}
                style={{ width: `${share * 100}%`, background: toneInk(tone) }}
              />
            </span>
            <span className={cn('num text-sm font-medium', dim && 'text-muted-foreground')}>
              {item.display}
            </span>
          </>
        );
        return (
          <li key={item.key}>
            {onSelect ? (
              <button
                type="button"
                aria-pressed={selected === item.key}
                onClick={() => onSelect(selected === item.key ? null : item.key)}
                className="hover:bg-muted focus-visible:ring-ring grid min-h-(--control-h-sm) w-full grid-cols-[minmax(5rem,9rem)_1fr_3.5rem] items-center gap-3 rounded-md px-1.5 py-1 text-start outline-none focus-visible:ring-2"
              >
                {row}
              </button>
            ) : (
              <div className="grid grid-cols-[minmax(5rem,9rem)_1fr_3.5rem] items-center gap-3 px-1.5 py-1">
                {row}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

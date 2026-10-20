/**
 * Small, pure helpers for the web app's own SVG charts (docs/design.md → Colour, Components).
 * No chart library: these do the arithmetic, the components draw.
 */

/** Maps `domain` onto `range` linearly. A zero-width domain maps everything to the range start. */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (value) => (span === 0 ? r0 : r0 + ((value - d0) / span) * (r1 - r0));
}

/** Round tick values (1, 2 or 5 × 10ⁿ apart) covering [min, max], about `count` of them. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const raw = (hi - lo) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude;
  const first = Math.ceil(lo / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = first; v <= hi + 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

/**
 * The y-domain for a present-% trend: from a multiple of 5 at or below the lowest value (so a
 * dip is visible, not flattened against 0) to 100. Empty or all-null data gives [80, 100].
 */
export function percentDomain(values: readonly (number | null)[]): [number, number] {
  const real = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (real.length === 0) return [80, 100];
  const low = Math.min(...real);
  return [Math.max(0, Math.min(80, Math.floor((low - 2) / 5) * 5)), 100];
}

export type RampStep = 1 | 2 | 3 | 4 | 5;

/**
 * The fixed ramp step for a present % (`--ramp-1…5`): below 88, 88–90, 91–93, 94–96, 97–100.
 * One mapping everywhere, so the same % has the same colour on every screen.
 */
export function percentRampStep(percent: number): RampStep {
  if (percent < 88) return 1;
  if (percent < 91) return 2;
  if (percent < 94) return 3;
  if (percent < 97) return 4;
  return 5;
}

/** Index of the smallest non-null value (the "lowest day" a chart labels), or -1. */
export function indexOfMin(values: readonly (number | null)[]): number {
  let at = -1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    if (at === -1 || v < values[at]!) at = i;
  }
  return at;
}

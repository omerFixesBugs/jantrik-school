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

export interface Point {
  x: number;
  y: number;
}

/** Two decimals: crisp enough on screen, short paths. */
const n = (v: number) => String(Math.round(v * 100) / 100);
const at = (p: Point) => `${n(p.x)},${n(p.y)}`;

/** Runs of consecutive points; a null (no value that day) ends a run. */
function runs(points: readonly (Point | null)[]): Point[][] {
  const out: Point[][] = [];
  let run: Point[] = [];
  for (const p of points) {
    if (p) run.push(p);
    else if (run.length) {
      out.push(run);
      run = [];
    }
  }
  if (run.length) out.push(run);
  return out;
}

/** A smooth curve through one run that never overshoots its points (Steffen's monotone cubic). */
function monotoneRun(pts: Point[]): string {
  if (pts.length === 1) return `M${at(pts[0]!)}`;
  if (pts.length === 2) return `M${at(pts[0]!)}L${at(pts[1]!)}`;
  const h = pts.slice(1).map((p, i) => p.x - pts[i]!.x);
  const s = pts.slice(1).map((p, i) => (h[i] ? (p.y - pts[i]!.y) / h[i]! : 0));
  const sign = (v: number) => (v < 0 ? -1 : 1);
  // The tangent at each inner point: zero at a peak, a trough or a plateau, and never so steep
  // that the curve leaves the band between its neighbours.
  const m = pts.map((_, i) => {
    if (i === 0 || i === pts.length - 1) return 0;
    const [s0, s1, h0, h1] = [s[i - 1]!, s[i]!, h[i - 1]!, h[i]!];
    const p = (s0 * h1 + s1 * h0) / (h0 + h1);
    return (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  });
  // The ends lean on their neighbour's tangent, as far as the first and last slopes allow.
  m[0] = (3 * s[0]! - m[1]!) / 2;
  m[pts.length - 1] = (3 * s[pts.length - 2]! - m[pts.length - 2]!) / 2;
  for (const i of [0, pts.length - 1]) {
    const slope = s[i === 0 ? 0 : pts.length - 2]!;
    if (Math.sign(m[i]!) !== Math.sign(slope) || Math.abs(m[i]!) > 3 * Math.abs(slope)) {
      m[i] = Math.sign(m[i]!) !== Math.sign(slope) ? 0 : 3 * slope;
    }
  }
  let d = `M${at(pts[0]!)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b, dx] = [pts[i]!, pts[i + 1]!, h[i]! / 3];
    d += `C${n(a.x + dx)},${n(a.y + dx * m[i]!)},${n(b.x - dx)},${n(b.y - dx * m[i + 1]!)},${at(b)}`;
  }
  return d;
}

/**
 * The trend's smooth line: a monotone curve through the points (it never invents a high or low
 * between two days), broken where a value is missing.
 */
export function monotonePath(points: readonly (Point | null)[]): string {
  return runs(points).map(monotoneRun).join('');
}

/** The area under the curve, each run closed down to `baseline` (for the gradient wash). */
export function monotoneArea(points: readonly (Point | null)[], baseline: number): string {
  return runs(points)
    .map(
      (run) =>
        `${monotoneRun(run)}L${n(run.at(-1)!.x)},${n(baseline)}L${n(run[0]!.x)},${n(baseline)}Z`,
    )
    .join('');
}

/** A point on a circle, the angle in degrees clockwise from 12 o'clock. */
export function polar(cx: number, cy: number, r: number, deg: number): Point {
  const a = (deg * Math.PI) / 180;
  return { x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) };
}

/**
 * An arc from `start` to `end` (degrees clockwise from 12 o'clock): the half gauge is -90 → 90,
 * donut slices go round from 0. A whole circle is drawn as two halves.
 */
export function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  const span = end - start;
  if (span <= 0) return '';
  const arc = (to: number, large: boolean) =>
    `A${n(r)},${n(r)} 0 ${large ? 1 : 0} 1 ${at(polar(cx, cy, r, to))}`;
  if (span >= 360) {
    return `M${at(polar(cx, cy, r, start))}${arc(start + 180, false)}${arc(start + 360, false)}`;
  }
  return `M${at(polar(cx, cy, r, start))}${arc(end, span > 180)}`;
}

export interface Slice {
  start: number;
  end: number;
  /** Of the whole (0 … 1). */
  share: number;
}

/**
 * Donut slices in the order given, from 12 o'clock round: angles in degrees, `gap` degrees of
 * ring left between neighbours (none when one slice is the whole). Nothing to share, no slices.
 */
export function donutSlices(values: readonly number[], gap = 0): Slice[] {
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  if (total <= 0) return [];
  const parts = values.filter((v) => v > 0).length;
  const pad = parts > 1 ? gap / 2 : 0;
  let angle = 0;
  return values.map((v) => {
    const share = Math.max(0, v) / total;
    const start = angle;
    angle += share * 360;
    return share > 0
      ? { start: start + pad, end: angle - pad, share }
      : { start: angle, end: angle, share: 0 };
  });
}

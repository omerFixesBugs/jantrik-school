import { describe, expect, it } from 'vitest';
import {
  arcPath,
  donutSlices,
  indexOfMin,
  linearScale,
  monotoneArea,
  monotonePath,
  niceTicks,
  percentDomain,
  percentRampStep,
} from './charts.js';

describe('linearScale', () => {
  it('maps the domain onto the range, inverted ranges included (SVG y grows down)', () => {
    const y = linearScale([80, 100], [200, 0]);
    expect(y(80)).toBe(200);
    expect(y(100)).toBe(0);
    expect(y(90)).toBe(100);
  });
  it('maps a zero-width domain to the range start', () => {
    expect(linearScale([5, 5], [0, 10])(5)).toBe(0);
  });
});

describe('niceTicks', () => {
  it('gives round steps', () => {
    expect(niceTicks(80, 100, 4)).toEqual([80, 85, 90, 95, 100]);
    expect(niceTicks(0, 1234, 4)).toEqual([0, 500, 1000]);
    expect(niceTicks(0.3, 2.1, 4)).toEqual([0.5, 1, 1.5, 2]);
  });
  it('handles a flat or unusable range', () => {
    expect(niceTicks(7, 7)).toEqual([7]);
    expect(niceTicks(Number.NaN, 3)).toEqual([]);
  });
});

describe('percentDomain', () => {
  it('starts at a multiple of 5 below the lowest day, ends at 100', () => {
    expect(percentDomain([94, 86, 97])).toEqual([80, 100]);
    expect(percentDomain([96, 93, null, 98])).toEqual([80, 100]);
    expect(percentDomain([61, 90])).toEqual([55, 100]);
  });
  it('defaults when there is nothing to show', () => {
    expect(percentDomain([])).toEqual([80, 100]);
    expect(percentDomain([null, null])).toEqual([80, 100]);
  });
});

describe('percentRampStep', () => {
  it('uses the fixed buckets', () => {
    expect(percentRampStep(0)).toBe(1);
    expect(percentRampStep(87.9)).toBe(1);
    expect(percentRampStep(88)).toBe(2);
    expect(percentRampStep(90.9)).toBe(2);
    expect(percentRampStep(91)).toBe(3);
    expect(percentRampStep(94)).toBe(4);
    expect(percentRampStep(96.99)).toBe(4);
    expect(percentRampStep(97)).toBe(5);
    expect(percentRampStep(100)).toBe(5);
  });
});

describe('indexOfMin', () => {
  it('finds the lowest real value', () => {
    expect(indexOfMin([95, null, 86, 90])).toBe(2);
    expect(indexOfMin([null, null])).toBe(-1);
    expect(indexOfMin([])).toBe(-1);
  });
});

/** The numbers of a path, segment by segment: [command, ...values]. */
const segments = (d: string) =>
  [...d.matchAll(/([MLCAZ])([^MLCAZ]*)/g)].map(([, c, rest]) => [
    c!,
    ...(rest!.match(/-?\d+(\.\d+)?/g) ?? []).map(Number),
  ]);

describe('monotonePath', () => {
  it('draws nothing for no points, a moveto for one, a line for two', () => {
    expect(monotonePath([])).toBe('');
    expect(monotonePath([null, null])).toBe('');
    expect(monotonePath([{ x: 10, y: 20 }])).toBe('M10,20');
    expect(
      monotonePath([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toBe('M0,0L10,10');
  });

  it('passes through every point and never overshoots between two of them', () => {
    const pts = [
      { x: 0, y: 50 },
      { x: 10, y: 20 },
      { x: 20, y: 22 },
      { x: 30, y: 80 },
      { x: 40, y: 79 },
    ];
    const segs = segments(monotonePath(pts));
    expect(segs[0]).toEqual(['M', 0, 50]);
    expect(segs).toHaveLength(pts.length);
    segs.slice(1).forEach((s, i) => {
      expect(s[0]).toBe('C');
      const [, , c1y, , c2y, x, y] = s as [string, number, number, number, number, number, number];
      expect([x, y]).toEqual([pts[i + 1]!.x, pts[i + 1]!.y]);
      const lo = Math.min(pts[i]!.y, pts[i + 1]!.y);
      const hi = Math.max(pts[i]!.y, pts[i + 1]!.y);
      for (const c of [c1y, c2y]) {
        expect(c).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(c).toBeLessThanOrEqual(hi + 1e-9);
      }
    });
  });

  it('keeps a flat run flat (a plateau is not drawn as a bump)', () => {
    const segs = segments(
      monotonePath([
        { x: 0, y: 5 },
        { x: 1, y: 5 },
        { x: 2, y: 8 },
      ]),
    );
    expect(segs[1]).toEqual(['C', 0.33, 5, 0.67, 5, 1, 5]);
  });

  it('breaks the line at a gap', () => {
    const d = monotonePath([{ x: 0, y: 1 }, { x: 1, y: 2 }, null, { x: 3, y: 2 }, { x: 4, y: 1 }]);
    expect(d).toBe('M0,1L1,2M3,2L4,1');
  });
});

describe('monotoneArea', () => {
  it('closes each run of the curve down to the baseline', () => {
    expect(monotoneArea([{ x: 0, y: 1 }, { x: 1, y: 2 }, null, { x: 3, y: 2 }], 10)).toBe(
      'M0,1L1,2L1,10L0,10ZM3,2L3,10L3,10Z',
    );
  });
});

describe('arcs', () => {
  it('measures angles clockwise from 12 o’clock', () => {
    // The half gauge: from 9 o'clock over the top to 3 o'clock.
    expect(arcPath(50, 50, 40, -90, 90)).toBe('M10,50A40,40 0 0 1 90,50');
    expect(arcPath(50, 50, 40, 0, 90)).toBe('M50,10A40,40 0 0 1 90,50');
    // More than half the circle takes the long way round.
    expect(segments(arcPath(50, 50, 40, 0, 270))[1]).toEqual(['A', 40, 40, 0, 1, 1, 10, 50]);
    // A whole circle is drawn as two halves (one arc cannot end where it starts).
    expect(arcPath(50, 50, 40, 0, 360)).toBe('M50,10A40,40 0 0 1 50,90A40,40 0 0 1 50,10');
    expect(arcPath(50, 50, 40, 30, 30)).toBe('');
  });

  it('splits a whole into slices in order, with a gap between them', () => {
    expect(donutSlices([1, 1, 2])).toEqual([
      { start: 0, end: 90, share: 0.25 },
      { start: 90, end: 180, share: 0.25 },
      { start: 180, end: 360, share: 0.5 },
    ]);
    expect(donutSlices([1, 3], 4)).toEqual([
      { start: 2, end: 88, share: 0.25 },
      { start: 92, end: 358, share: 0.75 },
    ]);
    // One slice is the whole ring (no gap to make); nothing to share is no slices.
    expect(donutSlices([5, 0], 4)).toEqual([
      { start: 0, end: 360, share: 1 },
      { start: 360, end: 360, share: 0 },
    ]);
    expect(donutSlices([0, 0])).toEqual([]);
  });
});

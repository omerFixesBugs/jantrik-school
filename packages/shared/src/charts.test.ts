import { describe, expect, it } from 'vitest';
import { indexOfMin, linearScale, niceTicks, percentDomain, percentRampStep } from './charts.js';

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

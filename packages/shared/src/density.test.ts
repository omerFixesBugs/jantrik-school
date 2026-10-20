import { describe, expect, it } from 'vitest';
import { COMPACT_MIN_WIDTH, defaultDensity, isDensity } from './density.js';

describe('defaultDensity', () => {
  it('is compact for desk roles on a wide screen', () => {
    for (const role of ['OWNER', 'ADMIN', 'ACCOUNTANT', 'STAFF'] as const) {
      expect(defaultDensity({ role, viewportWidth: 1366 })).toBe('compact');
    }
  });

  it('is comfortable for teachers, guardians and students, even on a wide screen', () => {
    for (const role of ['TEACHER', 'GUARDIAN', 'STUDENT'] as const) {
      expect(defaultDensity({ role, viewportWidth: 1920 })).toBe('comfortable');
    }
  });

  it('is comfortable on every phone and small tablet', () => {
    expect(defaultDensity({ role: 'OWNER', viewportWidth: 390 })).toBe('comfortable');
    expect(defaultDensity({ role: 'ADMIN', viewportWidth: COMPACT_MIN_WIDTH - 1 })).toBe(
      'comfortable',
    );
    expect(defaultDensity({ role: null, viewportWidth: 360, platform: true })).toBe('comfortable');
  });

  it('is compact for the platform on a wide screen, whatever the institute role', () => {
    expect(defaultDensity({ role: null, viewportWidth: COMPACT_MIN_WIDTH, platform: true })).toBe(
      'compact',
    );
  });

  it('is comfortable when the role is not known yet', () => {
    expect(defaultDensity({ role: null, viewportWidth: 1920 })).toBe('comfortable');
  });
});

describe('isDensity', () => {
  it('accepts only the two densities', () => {
    expect(isDensity('compact')).toBe(true);
    expect(isDensity('comfortable')).toBe(true);
    expect(isDensity('dense')).toBe(false);
    expect(isDensity(null)).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { todayIn } from './dates.js';

describe('todayIn with a fixed test date (JANTRIK_TEST_TODAY)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fixes "today" in any timezone; an instant still gives its own date', () => {
    vi.stubEnv('JANTRIK_TEST_TODAY', '2026-10-21');
    vi.stubEnv('NODE_ENV', 'test');
    expect(todayIn('Asia/Dhaka')).toBe('2026-10-21');
    expect(todayIn('UTC')).toBe('2026-10-21');
    expect(todayIn('Asia/Dhaka', new Date('2026-10-17T20:30:00Z'))).toBe('2026-10-18');
  });

  it('is never used in production', () => {
    vi.stubEnv('JANTRIK_TEST_TODAY', '2020-01-01');
    vi.stubEnv('NODE_ENV', 'production');
    expect(todayIn('Asia/Dhaka')).not.toBe('2020-01-01');
  });

  it('refuses a value that is not a calendar date, instead of using the real one', () => {
    vi.stubEnv('JANTRIK_TEST_TODAY', '2026-02-30');
    vi.stubEnv('NODE_ENV', 'test');
    expect(() => todayIn('Asia/Dhaka')).toThrow(/JANTRIK_TEST_TODAY/);
  });
});

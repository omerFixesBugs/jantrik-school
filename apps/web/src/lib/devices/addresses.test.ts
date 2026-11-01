import type { DeviceAddress } from '@jantrik/shared';
import { describe, expect, it } from 'vitest';
import { guideAddress } from './addresses';

const address = (id: string, lastSeenAt: string, trusted = false): DeviceAddress => ({
  id,
  ip: `203.0.113.${id}`,
  firstSeenAt: '2026-10-21T01:00:00.000Z',
  lastSeenAt,
  punchCount: 0,
  trusted,
  trustedAt: trusted ? '2026-10-21T01:00:00.000Z' : null,
  trustedBy: trusted ? 'automatic' : null,
});

describe('the setup guide’s address', () => {
  it('none before the device has called', () => {
    expect(guideAddress([])).toBeNull();
  });

  it('the trusted address, even when an untrusted one called later (an outsider with the serial)', () => {
    const ours = address('1', '2026-10-21T02:00:00.000Z', true);
    const outsider = address('2', '2026-10-21T02:05:00.000Z');
    expect(guideAddress([outsider, ours])).toBe(ours);
  });

  it('of several trusted ones, the one seen last', () => {
    const old = address('1', '2026-10-20T02:00:00.000Z', true);
    const now = address('2', '2026-10-21T02:00:00.000Z', true);
    expect(guideAddress([old, now, address('3', '2026-10-21T03:00:00.000Z')])).toBe(now);
  });

  it('while none is trusted, the untrusted one seen last', () => {
    const first = address('1', '2026-10-21T02:00:00.000Z');
    const latest = address('2', '2026-10-21T02:05:00.000Z');
    expect(guideAddress([first, latest])).toBe(latest);
    expect(guideAddress([latest, first])).toBe(latest);
  });
});

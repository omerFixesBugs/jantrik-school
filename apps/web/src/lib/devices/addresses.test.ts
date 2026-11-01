import type { DeviceAddress } from '@jantrik/shared';
import { describe, expect, it } from 'vitest';
import { guideAddresses } from './addresses';

const address = (
  id: string,
  firstSeenAt: string,
  lastSeenAt: string,
  trusted = false,
): DeviceAddress => ({
  id,
  ip: `203.0.113.${id}`,
  firstSeenAt,
  lastSeenAt,
  punchCount: 0,
  trusted,
  trustedAt: trusted ? firstSeenAt : null,
  trustedBy: trusted ? 'automatic' : null,
});

describe('the setup guide’s addresses', () => {
  it('none before the device has called', () => {
    expect(guideAddresses([])).toBeNull();
  });

  it('the trusted address, even when an untrusted one called later (an outsider with the serial)', () => {
    const ours = address('1', '2026-10-21T01:00:00.000Z', '2026-10-21T02:00:00.000Z', true);
    const outsider = address('2', '2026-10-21T02:05:00.000Z', '2026-10-21T02:05:00.000Z');
    expect(guideAddresses([outsider, ours])).toEqual({ kind: 'TRUSTED', address: ours });
  });

  it('of several trusted ones, the one seen last', () => {
    const old = address('1', '2026-10-20T01:00:00.000Z', '2026-10-20T02:00:00.000Z', true);
    const now = address('2', '2026-10-21T01:00:00.000Z', '2026-10-21T02:00:00.000Z', true);
    expect(guideAddresses([old, now])).toEqual({ kind: 'TRUSTED', address: now });
  });

  it('while none is trusted, every address in the order they first called: the latest caller is not picked', () => {
    const device = address('1', '2026-10-21T01:00:00.000Z', '2026-10-21T02:00:00.000Z');
    const latest = address('2', '2026-10-21T01:30:00.000Z', '2026-10-21T02:05:00.000Z');
    const third = address('3', '2026-10-21T01:10:00.000Z', '2026-10-21T01:10:00.000Z');
    expect(guideAddresses([latest, third, device])).toEqual({
      kind: 'UNTRUSTED',
      addresses: [device, third, latest],
    });
  });
});

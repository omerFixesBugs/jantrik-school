import type { DeviceAddress } from '@jantrik/shared';

/**
 * The address the setup guide shows and offers to trust or revoke: the trusted one the device
 * called from last, or, while none is trusted, the untrusted one it called from last, with its
 * state. Never `DeviceView.lastIp`: that is the latest caller of any kind, and anyone who knows the
 * serial number can be it, so a guide built on it could ask the admin to trust an outsider while
 * the real device's address is trusted already.
 */
export function guideAddress(addresses: readonly DeviceAddress[]): DeviceAddress | null {
  const latest = (list: readonly DeviceAddress[]) =>
    list.reduce<DeviceAddress | null>(
      (best, a) =>
        best === null || Date.parse(a.lastSeenAt) > Date.parse(best.lastSeenAt) ? a : best,
      null,
    );
  return latest(addresses.filter((a) => a.trusted)) ?? latest(addresses);
}

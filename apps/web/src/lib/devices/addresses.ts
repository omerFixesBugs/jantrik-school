import type { DeviceAddress } from '@jantrik/shared';

/** What the setup guide shows about where the device called from. */
export type GuideAddresses =
  { kind: 'TRUSTED'; address: DeviceAddress } | { kind: 'UNTRUSTED'; addresses: DeviceAddress[] };

const time = (iso: string) => Date.parse(iso);

/**
 * The setup guide's addresses, from the device's address list. When one is trusted: the trusted
 * address seen last (the guide offers to revoke it). While none is: every untrusted address, in the
 * order they first called, so the admin picks the institute's own. The guide never picks one for
 * them: anyone who knows the serial number can call, and the address seen last is only the latest
 * caller (`DeviceView.lastIp`). Null before the device has called.
 */
export function guideAddresses(addresses: readonly DeviceAddress[]): GuideAddresses | null {
  const trusted = addresses
    .filter((a) => a.trusted)
    .sort((a, b) => time(b.lastSeenAt) - time(a.lastSeenAt))[0];
  if (trusted) return { kind: 'TRUSTED', address: trusted };
  if (addresses.length === 0) return null;
  return {
    kind: 'UNTRUSTED',
    addresses: [...addresses].sort(
      (a, b) => time(a.firstSeenAt) - time(b.firstSeenAt) || a.ip.localeCompare(b.ip),
    ),
  };
}

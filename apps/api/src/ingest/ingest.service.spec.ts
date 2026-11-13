import { addressBucket, clientAddress } from './ingest.service.js';

describe('client addresses', () => {
  it('reads IPv4-mapped IPv6 as IPv4 and refuses what is not an address', () => {
    expect(clientAddress('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddress('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddress('203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddress('2001:db8::1')).toBe('2001:db8::1');
    for (const bad of [undefined, '', 'abc', '1.2.3.4\nX', 'fe80::1%eth0', '999.1.1.1']) {
      expect(clientAddress(bad)).toBeNull();
    }
  });

  it('limits count IPv4 per address and IPv6 per /64', () => {
    expect(addressBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(addressBucket(null)).toBe('unknown');
    const bucket = '2001:db8:a:b::/64';
    for (const ip of [
      '2001:db8:a:b::1',
      '2001:db8:a:b:ffff:ffff:ffff:ffff',
      '2001:0db8:000a:000b:0:0:0:2',
      '2001:DB8:A:B::',
      '2001:db8:a:b::1.2.3.4',
    ]) {
      expect(addressBucket(ip)).toBe(bucket);
    }
    expect(addressBucket('2001:db8:a:c::1')).toBe('2001:db8:a:c::/64');
    expect(addressBucket('::1')).toBe('0:0:0:0::/64');
    expect(addressBucket('::')).toBe('0:0:0:0::/64');
    expect(addressBucket('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(addressBucket('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
    // An IPv4 tail is two groups, which decides how long the `::` gap is.
    expect(addressBucket('1::2:3:4:5:192.0.2.1')).toBe('1:0:2:3::/64');
  });
});

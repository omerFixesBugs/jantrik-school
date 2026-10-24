import { describe, expect, it } from 'vitest';
import {
  createDeviceSchema,
  deviceCommandsQuerySchema,
  punchFeedQuerySchema,
  reviewPunchSchema,
  updateDeviceSchema,
} from './devices-api.js';

const UUID = '0199f000-0000-7000-8000-000000000001';

describe('createDeviceSchema', () => {
  const base = { serialNo: 'ABC123456', name: 'Main gate', direction: 'IN' } as const;

  it('trims and upper-cases the serial number; brand ZKTeco; an empty gate is none', () => {
    expect(createDeviceSchema.parse({ ...base, serialNo: '  cqz7b1234567 ', gate: ' ' })).toEqual({
      brand: 'ZKTECO',
      serialNo: 'CQZ7B1234567',
      name: 'Main gate',
      gate: null,
      direction: 'IN',
    });
    expect(createDeviceSchema.parse({ ...base, gate: ' North ' }).gate).toBe('North');
  });

  it.each(['ABC12', 'A'.repeat(33), 'ABC-12345', 'ABC 12345', 'ABC\n12345'])(
    'rejects the serial number %j',
    (serialNo) => {
      expect(createDeviceSchema.safeParse({ ...base, serialNo }).success).toBe(false);
    },
  );

  it('rejects other brands, an empty or long name, a long gate and unknown directions', () => {
    for (const patch of [
      { brand: 'SUPREMA' },
      { name: '  ' },
      { name: 'x'.repeat(61) },
      { gate: 'x'.repeat(61) },
      { direction: 'SIDEWAYS' },
    ]) {
      expect(
        createDeviceSchema.safeParse({ ...base, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });
});

describe('updateDeviceSchema', () => {
  it('only what is sent changes; an empty gate clears it', () => {
    expect(updateDeviceSchema.parse({})).toEqual({});
    expect(updateDeviceSchema.parse({ gate: '' })).toEqual({ gate: null });
    expect(updateDeviceSchema.parse({ gate: null, isActive: false })).toEqual({
      gate: null,
      isActive: false,
    });
    expect(updateDeviceSchema.parse({ serialNo: ' abc123456' })).toEqual({ serialNo: 'ABC123456' });
  });
});

describe('punchFeedQuerySchema', () => {
  it('50 by default, 1 to 100', () => {
    expect(punchFeedQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(punchFeedQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    for (const limit of ['0', '101', 'x']) {
      expect(punchFeedQuerySchema.safeParse({ limit }).success, limit).toBe(false);
    }
  });

  it('flagged=1 and a device', () => {
    expect(punchFeedQuerySchema.parse({ flagged: '1', deviceId: UUID })).toEqual({
      limit: 50,
      flagged: true,
      deviceId: UUID,
    });
    expect(punchFeedQuerySchema.parse({ flagged: '0' }).flagged).toBe(false);
  });

  it('a cursor is what the feed returned, nothing else', () => {
    expect(punchFeedQuerySchema.parse({ after: `1792468800123_${UUID}` }).after).toBe(
      `1792468800123_${UUID}`,
    );
    for (const after of ['', 'abc', `1792468800123-${UUID}`, `x_${UUID}`, '1792468800123_x']) {
      expect(punchFeedQuerySchema.safeParse({ after }).success, after).toBe(false);
    }
  });
});

describe('the other queries', () => {
  it('review actions and command statuses', () => {
    expect(reviewPunchSchema.parse({ action: 'ACCEPT' })).toEqual({ action: 'ACCEPT' });
    expect(reviewPunchSchema.safeParse({ action: 'ACCEPTED' }).success).toBe(false);
    expect(deviceCommandsQuerySchema.parse({})).toEqual({});
    expect(deviceCommandsQuerySchema.parse({ status: 'FAILED' })).toEqual({ status: 'FAILED' });
    expect(deviceCommandsQuerySchema.safeParse({ status: 'LOST' }).success).toBe(false);
  });
});

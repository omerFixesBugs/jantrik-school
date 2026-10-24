import { describe, expect, it } from 'vitest';
import {
  createDeviceSchema,
  deviceCommandsQuerySchema,
  deviceDefaultsSchema,
  deviceImportQuerySchema,
  devicePeopleCsvQuerySchema,
  devicePeopleQuerySchema,
  punchFeedQuerySchema,
  removeFromDevicesSchema,
  reviewPunchSchema,
  setDeviceUserIdSchema,
  staffRangeCheckQuerySchema,
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

describe('people and device IDs', () => {
  it('the list: kind, unmapped=1 and a section', () => {
    expect(devicePeopleQuerySchema.parse({})).toEqual({});
    expect(
      devicePeopleQuerySchema.parse({ kind: 'STAFF', unmapped: '1', sectionId: UUID }),
    ).toEqual({ kind: 'STAFF', unmapped: true, sectionId: UUID });
    for (const bad of [{ kind: 'GUARDIAN' }, { sectionId: 'x' }, { unmapped: 'maybe' }]) {
      expect(devicePeopleQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('set: exactly one person; the ID as typed (Bangla digits) or null to clear', () => {
    expect(setDeviceUserIdSchema.parse({ studentId: UUID, deviceUserId: ' ২০২৬০০৪২ ' })).toEqual({
      studentId: UUID,
      deviceUserId: '20260042',
    });
    expect(setDeviceUserIdSchema.parse({ staffUserId: UUID, deviceUserId: null })).toEqual({
      staffUserId: UUID,
      deviceUserId: null,
    });
    for (const bad of [
      { deviceUserId: '101' },
      { studentId: UUID, staffUserId: UUID, deviceUserId: '101' },
      { studentId: UUID },
      { studentId: UUID, deviceUserId: '' },
      { studentId: UUID, deviceUserId: '0101' },
      { studentId: UUID, deviceUserId: '99' },
    ]) {
      expect(setDeviceUserIdSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('defaults, CSV locale and the import step', () => {
    expect(deviceDefaultsSchema.parse({ kind: 'ALL', dryRun: true })).toEqual({
      kind: 'ALL',
      dryRun: true,
    });
    expect(deviceDefaultsSchema.safeParse({ kind: 'ALL' }).success).toBe(false);
    expect(deviceDefaultsSchema.safeParse({ kind: 'GUARDIAN', dryRun: false }).success).toBe(false);
    expect(devicePeopleCsvQuerySchema.parse({})).toEqual({ locale: 'bn' });
    expect(devicePeopleCsvQuerySchema.safeParse({ locale: 'ar' }).success).toBe(false);
    expect(deviceImportQuerySchema.parse({})).toEqual({ apply: false });
    expect(deviceImportQuerySchema.parse({ apply: '1' })).toEqual({ apply: true });
    expect(deviceImportQuerySchema.parse({ apply: '0' })).toEqual({ apply: false });
    expect(deviceImportQuerySchema.safeParse({ apply: 'yes' }).success).toBe(false);
  });

  it('remove from devices: 1 to 500 valid IDs, each once', () => {
    expect(removeFromDevicesSchema.parse({ deviceUserIds: ['101', '১০১', '102'] })).toEqual({
      deviceUserIds: ['101', '102'],
    });
    const many = Array.from({ length: 501 }, (_, i) => String(1000 + i));
    for (const deviceUserIds of [[], ['12'], many]) {
      expect(removeFromDevicesSchema.safeParse({ deviceUserIds }).success).toBe(false);
    }
    expect(
      removeFromDevicesSchema.parse({ deviceUserIds: many.slice(0, 500) }).deviceUserIds,
    ).toHaveLength(500);
  });

  it('the staff range check: a start from 100, Bangla digits accepted', () => {
    expect(staffRangeCheckQuerySchema.parse({ start: '৯০০১' })).toEqual({ start: 9001 });
    expect(staffRangeCheckQuerySchema.parse({ start: '100' })).toEqual({ start: 100 });
    for (const start of ['99', '1000000000', 'x', '', '9.5']) {
      expect(staffRangeCheckQuerySchema.safeParse({ start }).success, start).toBe(false);
    }
  });
});

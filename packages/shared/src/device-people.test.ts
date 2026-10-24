import { describe, expect, it } from 'vitest';
import {
  checkDeviceImport,
  defaultDeviceIds,
  importStudentCode,
  type DeviceImportLine,
  type DeviceImportLookup,
} from './device-people.js';

describe('defaultDeviceIds', () => {
  it('students get the digits of their code; mapped people keep theirs', () => {
    expect(
      defaultDeviceIds({
        students: [
          { key: 's1', code: 'SHS-2026-0042', current: null },
          { key: 's2', code: 'SHS-2026-0043', current: '555' },
        ],
        staff: [],
        held: new Set(['555']),
        onDevice: new Map(),
        staffStart: 9001,
      }),
    ).toEqual({ assigned: [{ key: 's1', deviceUserId: '20260042' }], conflicts: [] });
  });

  it('no usable digits, held by anyone, or wanted by two unmapped students: none of them assigned', () => {
    expect(
      defaultDeviceIds({
        students: [
          { key: 'bad', code: 'ABC', current: null },
          { key: 'held', code: 'X-777', current: null },
          { key: 'a', code: 'A-26-001', current: null },
          { key: 'b', code: 'B-26001', current: null },
          // Mapped elsewhere: does not compete for 30001.
          { key: 'm', code: 'M-30001', current: '444' },
          { key: 'c', code: 'C-30001', current: null },
        ],
        staff: [],
        // 777 is held by someone not listed (an inactive student, say).
        held: new Set(['444', '777']),
        onDevice: new Map(),
        staffStart: 9001,
      }),
    ).toEqual({
      assigned: [{ key: 'c', deviceUserId: '30001' }],
      conflicts: [
        { key: 'bad', deviceUserId: null, reason: 'NO_DEFAULT' },
        { key: 'held', deviceUserId: '777', reason: 'TAKEN' },
        { key: 'a', deviceUserId: '26001', reason: 'SHARED' },
        { key: 'b', deviceUserId: '26001', reason: 'SHARED' },
      ],
    });
  });

  it('staff, in order, from the start: skipping used numbers and every student code number', () => {
    expect(
      defaultDeviceIds({
        students: [
          // Mapped or not, a student's code number is never given to staff.
          { key: 's1', code: 'S-9002', current: '20260001' },
          { key: 's2', code: 'S-9004', current: null },
        ],
        staff: [
          { key: 't1', current: null },
          { key: 't2', current: '9001' },
          { key: 't3', current: null },
          { key: 't4', current: null },
        ],
        held: new Set(['20260001', '9001', '9003']),
        onDevice: new Map(),
        staffStart: 9001,
      }).assigned,
    ).toEqual([
      { key: 's2', deviceUserId: '9004' },
      { key: 't1', deviceUserId: '9005' },
      { key: 't3', deviceUserId: '9006' },
      { key: 't4', deviceUserId: '9007' },
    ]);
  });

  it('a number still on a device for someone else is not given; its own person may have it back', () => {
    expect(
      defaultDeviceIds({
        students: [
          // 301 was taken from someone else and a device still has them under it.
          { key: 's1', code: 'S-301', current: null },
          // 302 was taken from s2 and is still on a device for s2.
          { key: 's2', code: 'S-302', current: null },
        ],
        staff: [{ key: 't1', current: null }],
        held: new Set(),
        onDevice: new Map([
          ['301', 'gone'],
          ['302', 's2'],
          ['9001', 'old staff'],
        ]),
        staffStart: 9001,
      }),
    ).toEqual({
      assigned: [
        { key: 's2', deviceUserId: '302' },
        { key: 't1', deviceUserId: '9002' },
      ],
      conflicts: [{ key: 's1', deviceUserId: '301', reason: 'ID_STILL_ON_DEVICE' }],
    });
  });

  it('a changed start is honoured; no free number left is a conflict', () => {
    const staff = [{ key: 't1', current: null }];
    expect(
      defaultDeviceIds({
        students: [],
        staff,
        held: new Set(),
        onDevice: new Map(),
        staffStart: 500,
      }).assigned,
    ).toEqual([{ key: 't1', deviceUserId: '500' }]);
    expect(
      defaultDeviceIds({
        students: [],
        staff: [...staff, { key: 't2', current: null }],
        held: new Set(['999999998']),
        onDevice: new Map(),
        staffStart: 999_999_998,
      }),
    ).toEqual({
      assigned: [{ key: 't1', deviceUserId: '999999999' }],
      conflicts: [{ key: 't2', deviceUserId: null, reason: 'NO_DEFAULT' }],
    });
  });
});

describe('importStudentCode', () => {
  it('trimmed, upper case, ASCII digits', () => {
    expect(importStudentCode('  shs-২০২৬-০০৪২ ')).toBe('SHS-2026-0042');
  });
});

describe('checkDeviceImport', () => {
  // s1 holds 101, s2 holds 102, t1 holds 9001; 'gone' (not nameable by the file) holds 500.
  const lookup: DeviceImportLookup = {
    students: new Map([
      ['SHS-1', 's1'],
      ['SHS-2', 's2'],
      ['SHS-3', 's3'],
      ['SHS-4', 's4'],
    ]),
    staff: new Map([
      ['+8801711000001', 't1'],
      ['+8801711000002', 't2'],
    ]),
    current: new Map([
      ['s1', '101'],
      ['s2', '102'],
      ['t1', '9001'],
    ]),
    holders: new Map([
      ['101', 's1'],
      ['102', 's2'],
      ['9001', 't1'],
      ['500', 'gone'],
    ]),
    onDevice: new Map(),
  };
  const line = (row: number, studentCode: string, staffPhone: string, deviceId: string) =>
    ({ row, studentCode, staffPhone, deviceId }) satisfies DeviceImportLine;

  it('one error per row, in order: keys, person, ID format', () => {
    expect(
      checkDeviceImport(
        [
          line(2, '', '', '301'),
          line(3, 'SHS-3', '01711000002', '301'),
          line(4, 'SHS-9', '', '301'),
          line(5, '', '01711000009', '301'),
          line(6, '', 'not a phone', '301'),
          line(7, 'SHS-3', '', '0301'),
          line(8, 'SHS-4', '', 'x'),
        ],
        lookup,
      ),
    ).toEqual([
      { row: 2, key: null, deviceUserId: '301', status: 'ERROR', error: 'NO_PERSON_KEY' },
      { row: 3, key: null, deviceUserId: '301', status: 'ERROR', error: 'BOTH_KEYS' },
      { row: 4, key: null, deviceUserId: '301', status: 'ERROR', error: 'UNKNOWN_STUDENT' },
      { row: 5, key: null, deviceUserId: '301', status: 'ERROR', error: 'UNKNOWN_STAFF' },
      { row: 6, key: null, deviceUserId: '301', status: 'ERROR', error: 'UNKNOWN_STAFF' },
      { row: 7, key: 's3', deviceUserId: null, status: 'ERROR', error: 'BAD_DEVICE_ID' },
      { row: 8, key: 's4', deviceUserId: null, status: 'ERROR', error: 'BAD_DEVICE_ID' },
    ]);
  });

  it('codes in any case with Bangla digits; phones as typed, also without the 0 Excel drops', () => {
    expect(
      checkDeviceImport(
        [
          line(2, ' shs-৩ ', '', '৩০১'),
          line(3, '', '1711000002', '9002'),
          line(4, '', '+880 1711-000001', '9001'),
        ],
        lookup,
      ),
    ).toEqual([
      { row: 2, key: 's3', deviceUserId: '301', status: 'OK' },
      { row: 3, key: 't2', deviceUserId: '9002', status: 'OK' },
      { row: 4, key: 't1', deviceUserId: '9001', status: 'UNCHANGED' },
    ]);
  });

  it('an empty ID clears; clearing someone without one changes nothing', () => {
    expect(
      checkDeviceImport([line(2, 'SHS-1', '', ' '), line(3, 'SHS-3', '', '')], lookup),
    ).toEqual([
      { row: 2, key: 's1', deviceUserId: null, status: 'OK' },
      { row: 3, key: 's3', deviceUserId: null, status: 'UNCHANGED' },
    ]);
  });

  it('the same person twice, or the same ID on two rows: every such row is an error', () => {
    expect(
      checkDeviceImport(
        [
          line(2, 'SHS-3', '', '301'),
          line(3, 'shs-3', '', '302'),
          line(4, 'SHS-4', '', '303'),
          line(5, '', '01711000002', '303'),
          // Unchanged, but another row wants the same number.
          line(6, 'SHS-1', '', '101'),
          line(7, 'SHS-2', '', '101'),
          // Rows that already failed do not make duplicates.
          line(8, 'SHS-9', '', '304'),
          line(9, '', '01711000002x', '304'),
        ],
        lookup,
      ).map((r) => [r.row, r.status, r.error]),
    ).toEqual([
      [2, 'ERROR', 'DUPLICATE_PERSON'],
      [3, 'ERROR', 'DUPLICATE_PERSON'],
      [4, 'ERROR', 'DUPLICATE_ID'],
      [5, 'ERROR', 'DUPLICATE_ID'],
      [6, 'ERROR', 'DUPLICATE_ID'],
      [7, 'ERROR', 'DUPLICATE_ID'],
      [8, 'ERROR', 'UNKNOWN_STUDENT'],
      [9, 'ERROR', 'UNKNOWN_STAFF'],
    ]);
  });

  it('an ID held by someone the file does not move away is TAKEN; a swap is fine', () => {
    expect(
      checkDeviceImport(
        [
          // s1 and s2 swap.
          line(2, 'SHS-1', '', '102'),
          line(3, 'SHS-2', '', '101'),
          // Held by someone the file cannot name.
          line(4, 'SHS-3', '', '500'),
          // Held by t1, who stays.
          line(5, 'SHS-4', '', '9001'),
        ],
        lookup,
      ).map((r) => [r.row, r.status, r.error]),
    ).toEqual([
      [2, 'OK', undefined],
      [3, 'OK', undefined],
      [4, 'ERROR', 'TAKEN'],
      [5, 'ERROR', 'TAKEN'],
    ]);
  });

  it('TAKEN follows a chain: whoever waits on a person who cannot move cannot move either', () => {
    expect(
      checkDeviceImport(
        [
          // s3 wants s1's 101; s1 wants s2's 102; s2 wants 500, held by someone who stays.
          line(2, 'SHS-3', '', '101'),
          line(3, 'SHS-1', '', '102'),
          line(4, 'SHS-2', '', '500'),
          // t1 clears: their 9001 is free for t2.
          line(5, '', '01711000001', ''),
          line(6, '', '01711000002', '9001'),
        ],
        lookup,
      ).map((r) => [r.row, r.status, r.error]),
    ).toEqual([
      [2, 'ERROR', 'TAKEN'],
      [3, 'ERROR', 'TAKEN'],
      [4, 'ERROR', 'TAKEN'],
      [5, 'OK', undefined],
      [6, 'OK', undefined],
    ]);
  });

  it('an ID still on a device for someone else is refused, also when its holder moves; its own person may take it back', () => {
    const synced: DeviceImportLookup = {
      ...lookup,
      // s1's 101 is on a device; 600 was taken from s3 and 700 from someone the file cannot
      // name, and devices still have them.
      onDevice: new Map([
        ['101', 's1'],
        ['600', 's3'],
        ['700', 'old'],
      ]),
    };
    expect(
      checkDeviceImport(
        [
          // s1 and s2 try to swap: s2 may not take 101, so s2 stays and 102 is not free for s1.
          line(2, 'SHS-1', '', '102'),
          line(3, 'SHS-2', '', '101'),
          line(4, 'SHS-3', '', '600'),
          line(5, 'SHS-4', '', '700'),
        ],
        synced,
      ).map((r) => [r.row, r.status, r.error]),
    ).toEqual([
      [2, 'ERROR', 'TAKEN'],
      [3, 'ERROR', 'ID_STILL_ON_DEVICE'],
      [4, 'OK', undefined],
      [5, 'ERROR', 'ID_STILL_ON_DEVICE'],
    ]);
  });
});

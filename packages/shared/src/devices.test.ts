import { describe, expect, it } from 'vitest';
import {
  arrivalStatus,
  autoCloseEnd,
  closeDecision,
  commandLine,
  countsForAttendance,
  countsOnDay,
  cutoffTime,
  defaultStudentDeviceId,
  deviceDisplayName,
  deviceIdCollisions,
  deviceRegisterState,
  deviceState,
  deviceUserIdSchema,
  entrySmsText,
  exitSmsText,
  firstCountingIn,
  handshakeOptions,
  interpretPunch,
  MAX_ATTLOG_LINES,
  movementOf,
  nextClockOffset,
  nextStaffDeviceId,
  outsideHours,
  parseAttlog,
  parseDeviceCmdResults,
  parseInfo,
  punchDirection,
  punchOutcome,
  sendsSms,
  userDeletePayload,
  userUpsertPayload,
  verifyKind,
} from './devices.js';
import { smsLength } from './sms.js';

const T = '\t';
const BOM = String.fromCharCode(0xfeff);

describe('parseAttlog', () => {
  it('parses LF and CRLF lines, extra fields and trailing tabs', () => {
    const body = `7${T}2026-10-24 08:01:02${T}0${T}1${T}0${T}extra${T}\r\n12${T}2026-10-24 08:05:00${T}${T}${T}\r\n`;
    const r = parseAttlog(body);
    expect(r.lines).toBe(2);
    expect(r.rejected).toBe(0);
    expect(r.tooMany).toBe(false);
    expect(r.punches).toEqual([
      { pin: '7', deviceTime: '2026-10-24 08:01:02', state: 0, verify: 1 },
      { pin: '12', deviceTime: '2026-10-24 08:05:00', state: null, verify: null },
    ]);
  });

  it('strips a BOM and ignores blank lines without counting them', () => {
    const r = parseAttlog(`${BOM}5${T}2026-10-24 08:00:00\n\n   \n`);
    expect(r.lines).toBe(1);
    expect(r.punches).toEqual([
      { pin: '5', deviceTime: '2026-10-24 08:00:00', state: null, verify: null },
    ]);
  });

  it('rejects bad dates, impossible dates, long or odd PINs and bad numbers', () => {
    const body = [
      `1${T}2026-13-01 08:00:00`,
      `2${T}2026-02-30 08:00:00`,
      `3${T}2026-10-24 25:00:00`,
      `4${T}24-10-2026 08:00:00`,
      `${'9'.repeat(25)}${T}2026-10-24 08:00:00`,
      `a-b${T}2026-10-24 08:00:00`,
      `${T}2026-10-24 08:00:00`,
      `5${T}2026-10-24 08:00:00${T}300`,
      `6${T}2026-10-24 08:00:00${T}x`,
      `abc123${T}2026-10-24 08:00:00${T}255${T}0`,
    ].join('\n');
    const r = parseAttlog(body);
    expect(r.lines).toBe(10);
    expect(r.rejected).toBe(9);
    expect(r.punches.map((p) => p.pin)).toEqual(['abc123']);
  });

  it('refuses more than MAX_ATTLOG_LINES lines and returns no punches', () => {
    const line = `1${T}2026-10-24 08:00:00\n`;
    const ok = parseAttlog(line.repeat(MAX_ATTLOG_LINES));
    expect(ok.tooMany).toBe(false);
    expect(ok.punches).toHaveLength(MAX_ATTLOG_LINES);
    const big = parseAttlog(line.repeat(MAX_ATTLOG_LINES + 1));
    expect(big.tooMany).toBe(true);
    expect(big.punches).toEqual([]);
  });
});

describe('interpretPunch', () => {
  const base = {
    deviceTime: '2026-10-24 08:00:00',
    receivedAt: new Date('2026-10-24T02:00:30Z'),
    timeZone: 'Asia/Dhaka',
    clockOffsetSec: null,
    registeredOn: '2026-10-01',
  };

  it('uses the device time read in the institute zone', () => {
    expect(interpretPunch(base)).toEqual({
      skip: false,
      punchedAt: new Date('2026-10-24T02:00:00Z'),
      localDate: '2026-10-24',
      flags: [],
    });
  });

  it('subtracts a clock offset of 2 minutes or more and flags it', () => {
    expect(interpretPunch({ ...base, clockOffsetSec: 120 })).toMatchObject({
      skip: false,
      punchedAt: new Date('2026-10-24T01:58:00Z'),
      flags: ['CLOCK_CORRECTED'],
    });
    expect(interpretPunch({ ...base, clockOffsetSec: 119 })).toMatchObject({
      punchedAt: new Date('2026-10-24T02:00:00Z'),
      flags: [],
    });
    expect(interpretPunch({ ...base, clockOffsetSec: -300 })).toMatchObject({
      punchedAt: new Date('2026-10-24T02:05:00Z'),
      flags: ['CLOCK_CORRECTED'],
    });
  });

  it('clamps a punch more than 5 minutes in the future to receivedAt', () => {
    const received = new Date('2026-10-24T01:50:00Z');
    expect(interpretPunch({ ...base, receivedAt: received })).toMatchObject({
      punchedAt: received,
      flags: ['CLOCK_FUTURE'],
    });
    expect(interpretPunch({ ...base, receivedAt: new Date('2026-10-24T01:55:00Z') })).toMatchObject(
      { flags: [] },
    );
  });

  it('skips punches before the registration day (after correction)', () => {
    expect(interpretPunch({ ...base, registeredOn: '2026-10-25' })).toEqual({ skip: true });
    // 00:30 Dhaka on the 24th, corrected back an hour, falls on the 23rd
    expect(
      interpretPunch({
        ...base,
        deviceTime: '2026-10-24 00:30:00',
        clockOffsetSec: 3600,
        registeredOn: '2026-10-24',
      }),
    ).toEqual({ skip: true });
  });

  it('flags punches older than staleDays', () => {
    const receivedAt = new Date('2026-10-24T02:00:00Z');
    const run = (deviceTime: string, staleDays?: number) =>
      interpretPunch({ ...base, deviceTime, receivedAt, staleDays });
    expect(run('2026-10-16 08:00:00')).toMatchObject({ flags: ['STALE'] });
    expect(run('2026-10-17 08:00:00')).toMatchObject({ flags: [] });
    expect(run('2026-10-21 08:00:00', 2)).toMatchObject({ flags: ['STALE'] });
  });
});

describe('nextClockOffset', () => {
  it('needs 3 consistent samples before it sets an offset', () => {
    let s = nextClockOffset([], null, 400);
    expect(s).toEqual({ samples: [400], offset: null });
    s = nextClockOffset(s.samples, s.offset, 410);
    expect(s.offset).toBeNull();
    s = nextClockOffset(s.samples, s.offset, 405);
    expect(s.offset).toBe(405);
  });

  it('uses the median, rounded to a whole second', () => {
    expect(nextClockOffset([100, 130.4], null, 160).offset).toBe(130);
    expect(nextClockOffset([10, 20.5], null, 30).offset).toBe(21);
  });

  it('keeps the old offset when the last 3 samples span more than 90 s', () => {
    expect(nextClockOffset([100, 105], 99, 300).offset).toBe(99);
    expect(nextClockOffset([100, 190], null, 100).offset).toBe(100);
    expect(nextClockOffset([100, 191], 7, 100).offset).toBe(7);
  });

  it('ignores samples beyond 6 hours and keeps the last 5', () => {
    const before = { samples: [1, 2], offset: 5 };
    expect(nextClockOffset(before.samples, before.offset, 6 * 3600 + 1)).toEqual(before);
    expect(nextClockOffset([1], null, -(6 * 3600) - 1)).toEqual({ samples: [1], offset: null });
    expect(nextClockOffset([1], null, 6 * 3600).samples).toEqual([1, 6 * 3600]);
    expect(nextClockOffset([1, 2, 3, 4, 5], null, 6).samples).toEqual([2, 3, 4, 5, 6]);
  });
});

describe('punchDirection and verifyKind', () => {
  it('lets IN and OUT devices decide', () => {
    expect(punchDirection('IN', 1)).toBe('IN');
    expect(punchDirection('OUT', 0)).toBe('OUT');
  });
  it('reads the state on a BOTH device', () => {
    for (const s of [0, 3, 4, 9]) expect(punchDirection('BOTH', s)).toBe('IN');
    for (const s of [1, 2, 5, 8]) expect(punchDirection('BOTH', s)).toBe('OUT');
    expect(punchDirection('BOTH', 77)).toBe('IN');
    expect(punchDirection('BOTH', null)).toBe('IN');
  });
  it('maps verify codes', () => {
    expect(verifyKind(1)).toBe('FINGERPRINT');
    expect(verifyKind(3)).toBe('PASSWORD');
    expect(verifyKind(4)).toBe('CARD');
    expect(verifyKind(15)).toBe('FACE');
    expect(verifyKind(0)).toBe('OTHER');
    expect(verifyKind(2)).toBe('OTHER');
    expect(verifyKind(null)).toBe('OTHER');
  });
});

describe('handshakeOptions', () => {
  const at = new Date('2026-10-24T00:00:00Z');
  const opts = (attlogStamp: string | null, timeZone = 'Asia/Dhaka', legacy = false) =>
    handshakeOptions({ sn: 'ABC123456', attlogStamp, timeZone, at, legacy });

  it('answers in the fixed order', () => {
    expect(opts('9999')).toBe(
      [
        'GET OPTION FROM: ABC123456',
        'ATTLOGStamp=9999',
        'OPERLOGStamp=9999',
        'ATTPHOTOStamp=9999',
        'ErrorDelay=60',
        'Delay=30',
        'TransTimes=00:00;14:05',
        'TransInterval=1',
        'TransFlag=TransData AttLog',
        'TimeZone=6',
        'Realtime=1',
        'Encrypt=None',
        '',
      ].join('\n'),
    );
  });
  it('never sends a stamp of 0', () => {
    for (const s of [null, '', '0']) {
      const out = opts(s);
      expect(out).toContain('ATTLOGStamp=None\n');
      expect(out).not.toContain('Stamp=0');
    }
  });
  it('only writes a positive integer stamp, so nothing can inject option lines', () => {
    expect(opts('1234567890')).toContain('ATTLOGStamp=1234567890\n');
    const bad = [
      '00',
      '0',
      '-1',
      '12a',
      '1\nTransFlag=TransData FP',
      '1\r\nX=1',
      ' 5',
      '1'.repeat(20),
    ];
    for (const stamp of bad) {
      const out = opts(stamp);
      expect(out).toContain('ATTLOGStamp=None\n');
      expect(out.split('\n').filter((l) => l.startsWith('TransFlag='))).toHaveLength(1);
    }
  });
  it('refuses a serial number that is not valid', () => {
    const bad = ['', 'ABC12', 'A'.repeat(33), 'ABC123\nTransFlag=X', 'ABC 12345', 'ABC-12345'];
    for (const sn of bad) {
      expect(() =>
        handshakeOptions({ sn, attlogStamp: null, timeZone: 'Asia/Dhaka', at, legacy: false }),
      ).toThrow();
    }
  });
  it('uses the old key names for legacy firmware', () => {
    const out = opts(null, 'Asia/Dhaka', true);
    expect(out).toContain('\nStamp=None\nOpStamp=9999\nPhotoStamp=9999\n');
    expect(out).not.toContain('ATTLOGStamp');
  });
  it('writes minutes when the offset is not whole hours, and has no PushProtVer', () => {
    const out = opts(null, 'Asia/Kolkata');
    expect(out).toContain('TimeZone=330\n');
    for (const k of ['PushProtVer', 'MultiBioDataSupport', 'PushOptionsFlag']) {
      expect(out).not.toContain(k);
    }
    expect(out.endsWith('\n')).toBe(true);
    expect(out).not.toContain('\r');
  });
});

describe('device names and commands', () => {
  it('keeps printable ASCII, collapses spaces, trims and cuts to 24', () => {
    expect(deviceDisplayName('  Md.   Rahim  Uddin ', 'x')).toBe('Md. Rahim Uddin');
    expect(deviceDisplayName('Rahim\tUddin\nKhan', 'x')).toBe('RahimUddinKhan');
    expect(deviceDisplayName('A'.repeat(30), 'x')).toBe('A'.repeat(24));
    expect(deviceDisplayName('a'.repeat(23) + ' bcd', 'x')).toBe('a'.repeat(23));
  });
  it('falls back for empty or non-ASCII names, through the same filter', () => {
    expect(deviceDisplayName('রহিম', 'Student 7')).toBe('Student 7');
    expect(deviceDisplayName(null, 'Student 7')).toBe('Student 7');
    expect(deviceDisplayName('', 'Fall\tback')).toBe('Fallback');
  });
  it('builds payloads and command lines', () => {
    expect(userUpsertPayload('1001', 'Rahim')).toBe('DATA UPDATE USERINFO PIN=1001\tName=Rahim');
    expect(userDeletePayload('1001')).toBe('DATA DELETE USERINFO PIN=1001');
    expect(commandLine(5, 'X')).toBe('C:5:X');
    expect(commandLine(12345678901234n, 'X')).toBe('C:12345678901234:X');
  });
  it('a name with tabs or newlines never adds a second command or field', () => {
    const evil = 'Rahim\tPrivilege=14\r\nC:99:DATA DELETE USERINFO PIN=1001\nmore';
    const payload = userUpsertPayload('1001', evil);
    expect(payload).not.toMatch(/[\r\n]/);
    expect(payload.split('\t')).toHaveLength(2);
    expect(commandLine(7, payload).split(/\r?\n/)).toHaveLength(1);
    expect(() => commandLine(1, 'a\nb')).toThrow();
    expect(() => userUpsertPayload('10\t01', 'x')).toThrow();
    expect(() => userDeletePayload('10\n01')).toThrow();
  });
});

describe('parseDeviceCmdResults and parseInfo', () => {
  it('reads ID/Return/CMD lines in any key order and skips the rest', () => {
    const body = [
      'ID=5&Return=0&CMD=DATA',
      'Return=-1002&CMD=DATA&ID=6',
      'INFO=abc',
      'ID=x&Return=0&CMD=DATA',
      'ID=7&CMD=DATA',
      'ID=8&Return=ok&CMD=DATA',
      '',
      'key=value',
    ].join('\r\n');
    expect(parseDeviceCmdResults(body)).toEqual([
      { id: 5, returnCode: 0, cmd: 'DATA' },
      { id: 6, returnCode: -1002, cmd: 'DATA' },
    ]);
  });
  it('skips an ID past 2^53 and a Return outside int32, never Infinity or a rounded number', () => {
    const body = [
      `ID=${'9'.repeat(400)}&Return=0`, // Number() would give Infinity
      'ID=9007199254740993&Return=0', // past 2^53: would round to ...992
      `ID=1&Return=${'9'.repeat(400)}`,
      'ID=2&Return=2147483648',
      'ID=3&Return=-2147483649',
      'ID=9007199254740991&Return=2147483647',
      'ID=4&Return=-2147483648',
    ].join('\n');
    expect(parseDeviceCmdResults(body)).toEqual([
      { id: 9007199254740991, returnCode: 2147483647, cmd: '' },
      { id: 4, returnCode: -2147483648, cmd: '' },
    ]);
  });
  it('keeps only firmware and user count from INFO', () => {
    expect(parseInfo('Ver 6.60 Apr 2 2019,1523,3,1,192.168.1.5,10,1')).toEqual({
      firmware: 'Ver 6.60 Apr 2 2019',
      userCount: 1523,
    });
    expect(parseInfo(undefined)).toEqual({ firmware: null, userCount: null });
    expect(parseInfo('  ,-5')).toEqual({ firmware: null, userCount: null });
    const long = parseInfo(`${'v'.repeat(80)},12x`);
    expect(long.firmware).toHaveLength(60);
    expect(long.userCount).toBeNull();
    expect(parseInfo('V\u0001é1,0')).toEqual({ firmware: 'V1', userCount: 0 });
  });
});

describe('device user ids', () => {
  it('validates, accepting Bangla digits', () => {
    expect(deviceUserIdSchema.parse('১০০১')).toBe('1001');
    expect(deviceUserIdSchema.parse(' 123 ')).toBe('123');
    for (const bad of ['99', '0123', '1234567890', 'abc', '', '12 3']) {
      expect(deviceUserIdSchema.safeParse(bad).success).toBe(false);
    }
  });
  it('derives a default from a student code', () => {
    expect(defaultStudentDeviceId('SHS-2026-0042')).toBe('20260042');
    expect(defaultStudentDeviceId('ALO-26-001')).toBe('26001');
    expect(defaultStudentDeviceId('ABC')).toBeNull();
    expect(defaultStudentDeviceId('X-0001')).toBeNull();
    expect(defaultStudentDeviceId('0000123')).toBe('123');
    expect(defaultStudentDeviceId('1234567890')).toBeNull();
    expect(defaultStudentDeviceId('১২৩৪')).toBe('1234');
  });
  it('picks the next free staff id', () => {
    expect(nextStaffDeviceId(9001, new Set(), new Set())).toBe('9001');
    expect(nextStaffDeviceId(9001, new Set(['9001', '9003']), new Set(['9002']))).toBe('9004');
    expect(nextStaffDeviceId(5, new Set(), new Set())).toBe('100');
    expect(nextStaffDeviceId(999999999, new Set(['999999999']), new Set())).toBeNull();
    expect(nextStaffDeviceId(999999998, new Set(['999999998']), new Set())).toBe('999999999');
  });
  it('lists collisions', () => {
    expect(
      deviceIdCollisions([
        { key: 's1', kind: 'STUDENT', current: '5001', wanted: '5001' },
        { key: 's2', kind: 'STUDENT', current: null, wanted: '5001' }, // held by s1
        { key: 's3', kind: 'STUDENT', current: null, wanted: '7000' },
        { key: 's4', kind: 'STUDENT', current: null, wanted: '7000' }, // two unmapped
        { key: 't1', kind: 'STAFF', current: '9001', wanted: '9001' }, // fine
        { key: 't2', kind: 'STAFF', current: null, wanted: '9500' }, // fine, alone
        { key: 't3', kind: 'STAFF', current: null, wanted: null },
      ]),
    ).toEqual([
      { deviceUserId: '5001', wantedBy: ['s2'], heldBy: 's1' },
      { deviceUserId: '7000', wantedBy: ['s3', 's4'], heldBy: null },
    ]);
  });
  it('people who already have an ID: wanting one another person holds collides with its holder', () => {
    expect(
      deviceIdCollisions([
        { key: 's1', kind: 'STUDENT', current: '5001', wanted: '5001' },
        // Mapped to 6001, wants s1's 5001: collides with its holder, across kinds too.
        { key: 't1', kind: 'STAFF', current: '6001', wanted: '5001' },
        // Two people with an ID each swap them: each wants the other's.
        { key: 's2', kind: 'STUDENT', current: '7001', wanted: '7002' },
        { key: 's3', kind: 'STUDENT', current: '7002', wanted: '7001' },
        // Keeping their own: fine.
        { key: 's4', kind: 'STUDENT', current: '8001', wanted: '8001' },
      ]),
    ).toEqual([
      { deviceUserId: '5001', wantedBy: ['t1'], heldBy: 's1' },
      { deviceUserId: '7002', wantedBy: ['s2'], heldBy: 's3' },
      { deviceUserId: '7001', wantedBy: ['s3'], heldBy: 's2' },
    ]);
  });
});

describe('hours and punch rules', () => {
  it('outsideHours is inclusive to the second at the end', () => {
    const h = { start: '05:00', end: '20:00' };
    expect(outsideHours('04:59:59', h)).toBe(true);
    expect(outsideHours('05:00:00', h)).toBe(false);
    expect(outsideHours('20:00:00', h)).toBe(false);
    expect(outsideHours('20:00:01', h)).toBe(true);
  });
  it('countsForAttendance', () => {
    expect(countsForAttendance({ flags: [], review: null })).toBe(true);
    expect(countsForAttendance({ flags: ['NEW_IP'], review: null })).toBe(true);
    expect(countsForAttendance({ flags: [], review: 'REJECTED' })).toBe(false);
    expect(countsForAttendance({ flags: ['BURST'], review: null })).toBe(false);
    expect(countsForAttendance({ flags: ['BURST'], review: 'OK' })).toBe(false);
    expect(countsForAttendance({ flags: ['BURST'], review: 'ACCEPTED' })).toBe(true);
    expect(countsForAttendance({ flags: ['BURST'], review: 'REJECTED' })).toBe(false);
  });
  it('sendsSms needs a real-time, unflagged, counting punch', () => {
    const p = {
      flags: [] as ('NEW_IP' | 'OUTSIDE_HOURS' | 'STALE' | 'CLOCK_FUTURE' | 'CLOCK_CORRECTED')[],
      review: null,
      punchedAt: new Date('2026-10-24T02:00:00Z'),
      receivedAt: new Date('2026-10-24T02:10:00Z'),
    };
    expect(sendsSms(p)).toBe(true);
    expect(sendsSms({ ...p, punchedAt: new Date('2026-10-24T01:59:59Z') })).toBe(false);
    for (const f of ['NEW_IP', 'OUTSIDE_HOURS', 'STALE', 'CLOCK_FUTURE'] as const) {
      expect(sendsSms({ ...p, flags: [f] })).toBe(false);
    }
    expect(sendsSms({ ...p, flags: ['CLOCK_CORRECTED'] })).toBe(true);
    expect(sendsSms({ ...p, review: 'REJECTED' })).toBe(false);
  });
  it('sendsSms: never for a BURST punch, not even an accepted one (it still counts)', () => {
    const burst = {
      flags: ['BURST'] as const,
      punchedAt: new Date('2026-10-24T02:00:00Z'),
      receivedAt: new Date('2026-10-24T02:00:05Z'),
    };
    expect(countsForAttendance({ ...burst, review: 'ACCEPTED' })).toBe(true);
    for (const review of [null, 'OK', 'ACCEPTED', 'REJECTED'] as const) {
      expect(sendsSms({ ...burst, review })).toBe(false);
    }
  });
  it('countsOnDay: counts for attendance and is not STALE', () => {
    expect(countsOnDay({ flags: ['NEW_IP'], review: null })).toBe(true);
    expect(countsOnDay({ flags: ['STALE'], review: null })).toBe(false);
    expect(countsOnDay({ flags: ['STALE'], review: 'OK' })).toBe(false);
    expect(countsOnDay({ flags: [], review: 'REJECTED' })).toBe(false);
    expect(countsOnDay({ flags: ['BURST'], review: 'ACCEPTED' })).toBe(true);
  });
  it('punchOutcome: STALE, rejected, held, unmapped, inactive, then applied, in that order', () => {
    const active = { active: true };
    const inactive = { active: false };
    expect(punchOutcome({ flags: ['STALE', 'BURST'], review: 'REJECTED' }, null)).toBe('STALE');
    expect(punchOutcome({ flags: ['BURST'], review: 'REJECTED' }, active)).toBe('IGNORED');
    expect(punchOutcome({ flags: ['BURST'], review: null }, null)).toBe('HELD');
    expect(punchOutcome({ flags: ['BURST'], review: 'OK' }, active)).toBe('HELD');
    expect(punchOutcome({ flags: ['BURST'], review: 'ACCEPTED' }, active)).toBe('APPLIED');
    expect(punchOutcome({ flags: ['NEW_IP'], review: null }, null)).toBe('UNMAPPED');
    expect(punchOutcome({ flags: [], review: null }, inactive)).toBe('IGNORED');
    expect(punchOutcome({ flags: ['OUTSIDE_HOURS'], review: null }, active)).toBe('APPLIED');
    expect(punchOutcome({ flags: [], review: 'OK' }, active)).toBe('APPLIED');
  });
});

describe('a student day: arrival, entry and exit', () => {
  type Flag = 'STALE' | 'BURST' | 'NEW_IP';
  const p = (
    id: string,
    time: string,
    direction: 'IN' | 'OUT',
    extra: { flags?: Flag[]; review?: 'OK' | 'ACCEPTED' | 'REJECTED' } = {},
  ) => ({
    id,
    punchedAt: new Date(`2026-10-24T${time}+06:00`),
    direction,
    flags: extra.flags ?? [],
    review: extra.review ?? null,
  });
  const movements = (day: ReturnType<typeof p>[]) => day.map((x) => movementOf(x, day));

  it('ENTRY for the first IN, EXIT for the first OUT after it, whatever the order given', () => {
    const day = [
      p('c', '13:00:00', 'OUT'),
      p('a', '07:50:00', 'IN'),
      p('d', '13:05:00', 'OUT'),
      p('b', '07:55:00', 'IN'),
    ];
    expect(movements(day)).toEqual(['EXIT', 'ENTRY', null, null]);
    expect(firstCountingIn(day)?.id).toBe('a');
  });
  it('an OUT before any IN is nothing; no IN means no arrival', () => {
    const day = [p('a', '07:00:00', 'OUT'), p('b', '07:50:00', 'IN'), p('c', '13:00:00', 'OUT')];
    expect(movements(day)).toEqual([null, 'ENTRY', 'EXIT']);
    expect(movements([p('a', '07:00:00', 'OUT')])).toEqual([null]);
    expect(firstCountingIn([p('a', '07:00:00', 'OUT')])).toBeNull();
  });
  it('punches that do not count are skipped: rejected, held BURST, STALE', () => {
    const day = [
      p('a', '07:40:00', 'IN', { review: 'REJECTED' }),
      p('b', '07:45:00', 'IN', { flags: ['BURST'] }),
      p('c', '07:47:00', 'IN', { flags: ['STALE'] }),
      p('d', '07:50:00', 'IN'),
      p('e', '13:00:00', 'OUT', { flags: ['BURST'] }),
      p('f', '13:05:00', 'OUT'),
    ];
    expect(movements(day)).toEqual([null, null, null, 'ENTRY', null, 'EXIT']);
    expect(firstCountingIn(day)?.id).toBe('d');
  });
  it('a flagged punch that counts still takes the place (no later SMS); an accepted BURST counts', () => {
    const day = [
      p('a', '07:40:00', 'IN', { flags: ['NEW_IP'] }),
      p('b', '07:50:00', 'IN'),
      p('c', '13:00:00', 'OUT', { flags: ['BURST'], review: 'ACCEPTED' }),
      p('d', '13:05:00', 'OUT'),
    ];
    expect(movements(day)).toEqual(['ENTRY', null, 'EXIT', null]);
  });
  it('the same time is ordered by id; the punch itself need not be in the list', () => {
    const day = [p('b', '07:50:00', 'IN'), p('a', '07:50:00', 'IN')];
    expect(movements(day)).toEqual([null, 'ENTRY']);
    expect(movementOf(p('0', '07:00:00', 'IN'), day)).toBe('ENTRY');
    expect(movementOf(p('z', '13:00:00', 'OUT'), day)).toBe('EXIT');
  });
});

describe('arrival, cutoff, close decision', () => {
  it('LATE only strictly after start + grace', () => {
    expect(arrivalStatus('08:10:00', '08:00', 10)).toBe('PRESENT');
    expect(arrivalStatus('08:10:01', '08:00', 10)).toBe('LATE');
    expect(arrivalStatus('07:00:00', '08:00', 0)).toBe('PRESENT');
    expect(arrivalStatus('08:00:01', '08:00', 0)).toBe('LATE');
  });
  it('two shifts have different cutoffs, clamped at the end of day', () => {
    expect(cutoffTime('07:30', 60)).toBe('08:30:00');
    expect(cutoffTime('12:00', 60)).toBe('13:00:00');
    expect(cutoffTime('23:30', 120)).toBe('23:59:59');
  });
  it('closeDecision covers each outcome', () => {
    const ok = {
      cutoffPassed: true,
      autoCloseEnded: false,
      devicesSeenRecently: true,
      enrolled: 100,
      arrived: 80,
      notOnDevice: 0,
    };
    expect(closeDecision(ok)).toBe('CLOSE');
    expect(closeDecision({ ...ok, cutoffPassed: false })).toBe('WAIT');
    expect(closeDecision({ ...ok, enrolled: 0, arrived: 0 })).toBe('WAIT');
    expect(closeDecision({ ...ok, devicesSeenRecently: false })).toBe('DEVICE_OFFLINE');
    expect(closeDecision({ ...ok, arrived: 49 })).toBe('TOO_MANY_MISSING');
    expect(closeDecision({ ...ok, arrived: 50 })).toBe('CLOSE'); // exactly half missing
    // One student who cannot punch (no ID, or not on any device yet) holds the section back.
    expect(closeDecision({ ...ok, notOnDevice: 1 })).toBe('NOT_ON_DEVICE');
    // Past the window it waits for a person, whatever else holds.
    expect(closeDecision({ ...ok, autoCloseEnded: true })).toBe('AUTO_CLOSE_ENDED');
  });
  it('closeDecision: an offline device first, then students not on a device, then too many missing, then the window', () => {
    const all = {
      cutoffPassed: true,
      autoCloseEnded: true,
      devicesSeenRecently: false,
      enrolled: 10,
      arrived: 2,
      notOnDevice: 3,
    };
    expect(closeDecision(all)).toBe('DEVICE_OFFLINE');
    expect(closeDecision({ ...all, devicesSeenRecently: true })).toBe('NOT_ON_DEVICE');
    expect(closeDecision({ ...all, devicesSeenRecently: true, notOnDevice: 0 })).toBe(
      'TOO_MANY_MISSING',
    );
    expect(closeDecision({ ...all, devicesSeenRecently: true, notOnDevice: 0, arrived: 10 })).toBe(
      'AUTO_CLOSE_ENDED',
    );
  });
  it('autoCloseEnd: an hour after the cutoff, clamped at the end of the day', () => {
    expect(autoCloseEnd('08:00', 60)).toBe('10:00:00');
    expect(autoCloseEnd('12:00', 90)).toBe('14:30:00');
    expect(autoCloseEnd('22:30', 60)).toBe('23:59:59');
  });
  it('deviceRegisterState: CLOSED once a register exists, else why it is not closed yet', () => {
    expect(deviceRegisterState(true, 'CLOSE')).toBe('CLOSED');
    expect(deviceRegisterState(true, 'WAIT')).toBe('CLOSED');
    expect(deviceRegisterState(true, 'DEVICE_OFFLINE')).toBe('CLOSED');
    expect(deviceRegisterState(true, 'NOT_ON_DEVICE')).toBe('CLOSED');
    expect(deviceRegisterState(false, 'WAIT')).toBe('BEFORE_CUTOFF');
    // Due: the next minute's tick writes it.
    expect(deviceRegisterState(false, 'CLOSE')).toBe('BEFORE_CUTOFF');
    expect(deviceRegisterState(false, 'DEVICE_OFFLINE')).toBe('DEVICE_OFFLINE');
    expect(deviceRegisterState(false, 'NOT_ON_DEVICE')).toBe('NOT_ON_DEVICE');
    expect(deviceRegisterState(false, 'TOO_MANY_MISSING')).toBe('TOO_MANY_MISSING');
    expect(deviceRegisterState(false, 'AUTO_CLOSE_ENDED')).toBe('AUTO_CLOSE_ENDED');
  });
  it('deviceState', () => {
    const now = new Date('2026-10-24T02:00:00Z');
    expect(deviceState(now, now, false)).toBe('INACTIVE');
    expect(deviceState(null, now, true)).toBe('NEVER_CONNECTED');
    expect(deviceState(new Date(now.getTime() - 120_000), now, true)).toBe('ONLINE');
    expect(deviceState(new Date(now.getTime() - 121_000), now, true)).toBe('OFFLINE');
  });
});

describe('entry and exit SMS text', () => {
  const at = new Date('2026-10-24T01:45:00Z'); // 07:45 Dhaka
  it('is fixed Bangla', () => {
    expect(entrySmsText({ student: 'তাসনিম', at, institute: 'শাপলা উচ্চ বিদ্যালয়' })).toBe(
      'তাসনিম প্রবেশ করেছে সকাল ৭:৪৫ — শাপলা উচ্চ বিদ্যালয়',
    );
    expect(exitSmsText({ student: 'তাসনিম', at, institute: 'শাপলা' })).toBe(
      'তাসনিম বের হয়েছে সকাল ৭:৪৫ — শাপলা',
    );
  });
  it('drops the institute when too long, then cuts the name', () => {
    const longInstitute = 'অ'.repeat(200);
    expect(entrySmsText({ student: 'তাসনিম', at, institute: longInstitute })).toBe(
      'তাসনিম প্রবেশ করেছে সকাল ৭:৪৫',
    );
    const longName = 'ক'.repeat(300);
    for (const fn of [entrySmsText, exitSmsText]) {
      const b = fn({ student: longName, at, institute: longInstitute });
      expect(smsLength(b).segments).toBeLessThanOrEqual(2);
      expect(b).toContain('সকাল ৭:৪৫');
      expect(b).not.toContain('—');
      expect(b.startsWith('ক')).toBe(true);
    }
  });

  const HASANT = String.fromCodePoint(0x09cd);
  const VERB = ' প্রবেশ করেছে ';
  const letters = (s: string) =>
    Array.from(new Intl.Segmenter('bn', { granularity: 'grapheme' }).segment(s), (x) => x.segment);

  it('cuts a long name between letters and keeps the longest name that fits', () => {
    // Conjuncts and vowel signs throughout; each extra prefix letter moves where the cut lands.
    for (let shift = 0; shift < 12; shift += 1) {
      const student = 'অ'.repeat(shift) + 'লক্ষ্মীকান্ত'.repeat(15);
      const text = entrySmsText({ student, at, institute: 'শাপলা' });
      const name = text.slice(0, text.indexOf(VERB));
      expect(smsLength(text).segments).toBeLessThanOrEqual(2);
      expect(name.endsWith(HASANT)).toBe(false);
      // A whole number of the name's letters: never a consonant without its vowel sign.
      const kept = letters(name);
      expect(letters(student).slice(0, kept.length)).toEqual(kept);
      // One letter more would not fit.
      const longer = letters(student)
        .slice(0, kept.length + 1)
        .join('');
      expect(smsLength(`${longer}${VERB}সকাল ৭:৪৫`).segments).toBeGreaterThan(2);
    }
  });

  it('without Intl.Segmenter (an old browser), a cut name still never ends on a hasant', () => {
    const segmenter = Intl.Segmenter;
    Object.assign(Intl, { Segmenter: undefined });
    try {
      for (let shift = 0; shift < 6; shift += 1) {
        const student = 'অ'.repeat(shift) + 'ক্ষ'.repeat(60);
        const text = exitSmsText({ student, at, institute: 'শাপলা' });
        const name = text.slice(0, text.indexOf(' বের হয়েছে '));
        expect(smsLength(text).segments).toBeLessThanOrEqual(2);
        expect(name.length).toBeGreaterThan(0);
        expect(name.endsWith(HASANT)).toBe(false);
        expect(student.startsWith(name)).toBe(true);
      }
    } finally {
      Object.assign(Intl, { Segmenter: segmenter });
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  broadcastInputSchema,
  broadcastProblems,
  inQuietHours,
  nextAllowedAt,
  scheduleBroadcastSchema,
  smsLength,
} from './index.js';

const DHAKA = 'Asia/Dhaka';
/** A Dhaka wall clock as an instant (UTC+6, no summer time). */
const dhaka = (local: string) => new Date(`${local}+06:00`);

describe('quiet hours 21:00–08:00 in the institute timezone (review focus 3)', () => {
  it('Dhaka: 20:59 allowed, 21:00 quiet, 07:59 quiet, 08:00 allowed', () => {
    expect(inQuietHours(dhaka('2026-11-17T20:59:59'), DHAKA)).toBe(false);
    expect(inQuietHours(dhaka('2026-11-17T21:00:00'), DHAKA)).toBe(true);
    expect(inQuietHours(dhaka('2026-11-18T07:59:59'), DHAKA)).toBe(true);
    expect(inQuietHours(dhaka('2026-11-18T08:00:00'), DHAKA)).toBe(false);
    expect(inQuietHours(dhaka('2026-11-18T00:00:00'), DHAKA)).toBe(true);
  });

  it('the next allowed time: itself when allowed, else the next 08:00', () => {
    const noon = dhaka('2026-11-17T12:00:00');
    expect(nextAllowedAt(noon, DHAKA)).toEqual(noon);
    // 23:30 → 08:00 the next day; 02:00 → 08:00 the same day.
    expect(nextAllowedAt(dhaka('2026-11-17T23:30:00'), DHAKA)).toEqual(dhaka('2026-11-18T08:00:00'));
    expect(nextAllowedAt(dhaka('2026-11-18T02:00:00'), DHAKA)).toEqual(dhaka('2026-11-18T08:00:00'));
    expect(nextAllowedAt(dhaka('2026-12-31T21:00:00'), DHAKA)).toEqual(dhaka('2027-01-01T08:00:00'));
  });

  it('a zone with summer time: nothing assumes UTC+6 (Europe/London, 25 October 2026)', () => {
    const london = 'Europe/London';
    // 20:30 BST (UTC+1) on 24 Oct is allowed; 21:00 BST is quiet.
    expect(inQuietHours(new Date('2026-10-24T19:30:00Z'), london)).toBe(false);
    expect(inQuietHours(new Date('2026-10-24T20:00:00Z'), london)).toBe(true);
    // From 22:00 BST on 24 Oct the next 08:00 is on 25 Oct, after the change to GMT: 08:00Z.
    expect(nextAllowedAt(new Date('2026-10-24T21:00:00Z'), london)).toEqual(
      new Date('2026-10-25T08:00:00Z'),
    );
    // 07:30 GMT on 26 Oct is quiet; 08:00 GMT allowed.
    expect(inQuietHours(new Date('2026-10-26T07:30:00Z'), london)).toBe(true);
    expect(inQuietHours(new Date('2026-10-26T08:00:00Z'), london)).toBe(false);
  });
});

describe('the 3-segment SMS limit', () => {
  it('Bangla (UCS-2): 201 UTF-16 units are 3 segments, 202 are refused', () => {
    const b201 = 'ক'.repeat(201);
    expect(smsLength(b201)).toMatchObject({ encoding: 'UCS2', segments: 3 });
    expect(broadcastProblems(b201)).toEqual([]);
    expect(broadcastProblems('ক'.repeat(202))).toEqual(['SMS_TOO_LONG']);
  });

  it('GSM-7: 459 characters fit, 460 are refused; empty or spaces only is EMPTY', () => {
    expect(broadcastProblems('a'.repeat(459))).toEqual([]);
    expect(broadcastProblems('a'.repeat(460))).toEqual(['SMS_TOO_LONG']);
    expect(broadcastProblems('   ')).toEqual(['EMPTY']);
  });
});

describe('broadcast schemas', () => {
  it('keeps the text as typed (line endings normalised), with the 480-character backstop', () => {
    expect(broadcastInputSchema.parse({ body: 'a\r\nb ', recipients: 'STAFF' })).toEqual({
      body: 'a\nb ',
      recipients: 'STAFF',
      targets: [],
      noticeId: null,
    });
    expect(broadcastInputSchema.safeParse({ body: '', recipients: 'STAFF' }).success).toBe(false);
    expect(
      broadcastInputSchema.safeParse({ body: 'x'.repeat(481), recipients: 'STAFF' }).success,
    ).toBe(false);
    expect(
      broadcastInputSchema.safeParse({ body: 'x', recipients: 'EVERYONE' }).success,
    ).toBe(false);
  });

  it('a schedule needs an instant with an offset and the confirmed count', () => {
    expect(
      scheduleBroadcastSchema.safeParse({ scheduledAt: '2026-11-18 10:00', expectedRecipients: 3 })
        .success,
    ).toBe(false);
    expect(
      scheduleBroadcastSchema.parse({
        scheduledAt: '2026-11-18T10:00:00+06:00',
        expectedRecipients: 3,
      }).scheduledAt,
    ).toEqual(new Date('2026-11-18T04:00:00Z'));
  });
});

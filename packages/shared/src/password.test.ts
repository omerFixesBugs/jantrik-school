import { describe, expect, it } from 'vitest';
import {
  PASSWORD_RULES,
  normalizePassword,
  passwordProblems,
  type PasswordProblem,
} from './password.js';
import { setPasswordSchema } from './password-schema.js';

describe('password rules (S26, P1-C, P1-D)', () => {
  it('counts code points after NFC: a Bangla password typed decomposed equals the composed one', () => {
    // য় typed as one code point (U+09DF) or as য + nukta (U+09AF U+09BC).
    const oneCodePoint = 'আমারপাসওয়ার্ড১২';
    const withNukta = 'আমারপাসওয়ার্ড১২';
    expect(oneCodePoint).not.toBe(withNukta);
    expect(normalizePassword(oneCodePoint)).toBe(normalizePassword(withNukta));
    // ো typed as one vowel sign (U+09CB) or as ে + া (U+09C7 U+09BE).
    expect(normalizePassword('ভালোবাসা১২৩৪')).toBe(normalizePassword('ভালোবাসা১২৩৪'));
    // Precomposed letters too: é typed as one code point or as e + accent.
    expect(normalizePassword('café')).toBe(normalizePassword('café'));
  });

  it('measures length in code points, not UTF-16 units', () => {
    // Ten emoji are twenty UTF-16 units but ten code points: long enough, not too long.
    expect(passwordProblems('😀'.repeat(10), about)).toEqual([]);
    expect(passwordProblems('😀'.repeat(9), about)).toEqual(['TOO_SHORT']);
    expect(passwordProblems('😀'.repeat(PASSWORD_RULES.max), about)).toEqual([]);
  });

  it('measures length after NFC: a decomposed password is not longer than it looks', () => {
    // Nine é typed decomposed are eighteen code points before NFC, nine after.
    expect(passwordProblems('é'.repeat(9), about)).toEqual(['TOO_SHORT']);
  });

  const about = {
    phone: '+8801711000002',
    instituteNames: ['শাপলা উচ্চ বিদ্যালয়', 'Alo Coaching', 'ABC'],
  };

  it.each<[string, string, PasswordProblem[]]>([
    ['short', 'abcdefghi', ['TOO_SHORT']],
    ['long', 'a'.repeat(129), ['TOO_LONG']],
    ['ok', 'a'.repeat(10), []],
    ['ok at the maximum', 'a'.repeat(128), []],
  ])('%s', (_c, pw, problems) => expect(passwordProblems(pw, about)).toEqual(problems));

  it.each([
    '01711000002',
    '+8801711000002',
    '8801711000002',
    '০১৭১১০০০০০২',
    'my-01711-000002!',
    'x+880 1711 000002y',
    '1711.000.002 pass',
    '(01711)000002x',
    '01711_000002ab',
    '017/1100/0002 ok',
    '০১৭১১–০০০০০২ dash',
  ])('refuses a password containing the phone number: %s', (pw) =>
    expect(passwordProblems(pw, about)).toContain('HAS_PHONE'),
  );

  it('does not refuse a password that only shares part of the phone number', () => {
    expect(passwordProblems('01711000003 mine', about)).not.toContain('HAS_PHONE');
  });

  it.each([
    'শাপলাউচ্চবিদ্যালয়2026',
    'শাপলা উচ্চ বিদ্যালয়!',
    'myALOcoaching!!',
    'alo coaching 123',
  ])('refuses a password containing an institute name (case and spaces ignored): %s', (pw) =>
    expect(passwordProblems(pw, about)).toContain('HAS_INSTITUTE_NAME'),
  );

  it('matches an institute name whichever Unicode form either side was typed in', () => {
    const decomposedName = { ...about, instituteNames: ['শাপলা উচ্চ বিদ্যালয়'.normalize('NFD')] };
    expect(passwordProblems('শাপলাউচ্চবিদ্যালয়2026', decomposedName)).toContain(
      'HAS_INSTITUTE_NAME',
    );
    expect(passwordProblems('শাপলাউচ্চবিদ্যালয়2026'.normalize('NFD'), about)).toContain(
      'HAS_INSTITUTE_NAME',
    );
  });

  it('skips institute names under 4 letters (they would refuse most passwords)', () => {
    expect(passwordProblems('abcdefghijk', about)).toEqual([]);
  });

  it('reports every problem at once', () => {
    expect(passwordProblems('01711000002alocoaching', about).sort()).toEqual(
      ['HAS_INSTITUTE_NAME', 'HAS_PHONE'].sort(),
    );
  });

  it('accepts Bangla digits in the code and refuses anything but 6 digits', () => {
    expect(setPasswordSchema.parse({ code: '১২৩৪৫৬', password: 'x' }).code).toBe('123456');
    expect(setPasswordSchema.parse({ code: ' 123456 ', password: 'x' }).code).toBe('123456');
    expect(() => setPasswordSchema.parse({ code: '12345', password: 'x' })).toThrow();
    expect(() => setPasswordSchema.parse({ code: '12345a', password: 'x' })).toThrow();
    expect(() => setPasswordSchema.parse({ code: '123456', password: 'x'.repeat(513) })).toThrow();
  });

  it('leaves the length rules to passwordProblems (the schema keeps only a size cap)', () => {
    expect(setPasswordSchema.parse({ code: '123456', password: 'short' }).password).toBe('short');
  });
});

import { isCommonPassword, readCommonPasswords } from './common-passwords.js';

describe('the common-password list (sprint 1 P1-D)', () => {
  it('finds SecLists entries and the Jantrik additions, ignoring case', () => {
    expect(isCommonPassword('1234567890')).toBe(true);
    expect(isCommonPassword('QWERTYUIOP')).toBe(true);
    expect(isCommonPassword('password123')).toBe(true);
    expect(isCommonPassword('Jantrik@2026')).toBe(true);
    expect(isCommonPassword('bangladesh2026')).toBe(true);
    expect(isCommonPassword('tea garden monsoon 7')).toBe(false);
  });

  it('holds the whole list, without its comment lines', () => {
    const list = readCommonPasswords();
    expect(list.size).toBeGreaterThan(10_000);
    expect([...list].some((p) => p.startsWith('#'))).toBe(false);
    expect(list.has('')).toBe(false);
  });

  it('a missing file is an error (the API reads it at start-up, so it would not start)', () => {
    expect(() => readCommonPasswords(new URL('./no-such-list.txt', import.meta.url))).toThrow();
  });
});

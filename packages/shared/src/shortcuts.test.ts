import { describe, expect, it } from 'vitest';
import {
  createGoSequence,
  isHelpShortcut,
  isNewShortcut,
  isPaletteShortcut,
  isSearchShortcut,
  type KeyLike,
} from './shortcuts.js';

const key = (code: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  code,
  key: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
});

describe('single shortcuts', () => {
  it('Ctrl+K and ⌘K open the palette, by key position (a Bangla layout types "ক" there)', () => {
    expect(isPaletteShortcut(key('KeyK', { ctrlKey: true, key: 'ক' }))).toBe(true);
    expect(isPaletteShortcut(key('KeyK', { metaKey: true }))).toBe(true);
    expect(isPaletteShortcut(key('KeyK'))).toBe(false);
    expect(isPaletteShortcut(key('KeyK', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPaletteShortcut(key('KeyK', { ctrlKey: true, isComposing: true }))).toBe(false);
  });
  it('? / and n', () => {
    expect(isHelpShortcut(key('Slash', { shiftKey: true }))).toBe(true);
    expect(isHelpShortcut(key('Slash'))).toBe(false);
    expect(isSearchShortcut(key('Slash'))).toBe(true);
    expect(isSearchShortcut(key('Slash', { ctrlKey: true }))).toBe(false);
    expect(isNewShortcut(key('KeyN'))).toBe(true);
    expect(isNewShortcut(key('KeyN', { metaKey: true }))).toBe(false);
  });
});

describe('createGoSequence', () => {
  const go = () => createGoSequence({ KeyD: '/dashboard', KeyS: '/students' }, 1500);

  it('g then a letter goes there', () => {
    const feed = go();
    expect(feed(key('KeyG'), 0)).toBeNull();
    expect(feed(key('KeyS'), 400)).toBe('/students');
  });
  it('too slow, an unknown letter, or a modifier cancels', () => {
    let feed = go();
    feed(key('KeyG'), 0);
    expect(feed(key('KeyS'), 2000)).toBeNull();
    feed = go();
    feed(key('KeyG'), 0);
    expect(feed(key('KeyX'), 100)).toBeNull();
    expect(feed(key('KeyS'), 200)).toBeNull();
    feed = go();
    feed(key('KeyG'), 0);
    expect(feed(key('KeyS', { ctrlKey: true }), 100)).toBeNull();
  });
  it('a letter on its own does nothing', () => {
    expect(go()(key('KeyD'), 0)).toBeNull();
  });
});

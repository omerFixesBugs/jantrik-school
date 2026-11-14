import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const messages = (file: string) => JSON.parse(read(`messages/${file}`)) as Record<string, never>;

/** A message by its dotted key, or undefined. */
function message(tree: Record<string, never>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], tree);
}

/**
 * Confirm dialogs with the kit's close button (the X, named by `common.close`): a confirm that
 * reads the same would give screen-reader users two identical buttons that do opposite things.
 */
const CONFIRMS = [
  // The fees setup's bKash/Nagad number switch-off (numbers-section.tsx, ToggleDialog).
  { file: 'fees/setup', key: 'setup.numbers.deactivateConfirm' },
  // The device switch-off (device-list.tsx, b485763).
  { file: 'devices/devices', key: 'devices.list.switchOffConfirm' },
];

describe.each(['bn', 'en'])(
  '%s: confirm buttons are named apart from the close button',
  (locale) => {
    const close = message(messages(`${locale}.json`), 'common.close');

    it.each(CONFIRMS)('$key', ({ file, key }) => {
      expect(typeof close).toBe('string');
      const confirm = message(messages(`${file}.${locale}.json`), key);
      expect(typeof confirm).toBe('string');
      expect((confirm as string).trim().toLowerCase()).not.toBe(
        (close as string).trim().toLowerCase(),
      );
    });
  },
);

describe('the confirm dialogs use their own label', () => {
  it('switching a bKash/Nagad number off confirms with deactivateConfirm', () => {
    const source = read('src/components/fees/setup/numbers-section.tsx');
    expect(source).toMatch(/confirmLabel=\{account\.isActive \? t\('deactivateConfirm'\)/);
  });

  it('switching a device off confirms with switchOffConfirm', () => {
    const source = read('src/components/devices/device-list.tsx');
    expect(source).toContain("confirmLabel={t('switchOffConfirm')}");
  });
});

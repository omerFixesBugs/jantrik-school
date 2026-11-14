import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const reports = (locale: string) =>
  (
    JSON.parse(readFileSync(path.join(root, `messages/${locale}.json`), 'utf8')) as {
      reports: Record<string, string>;
    }
  ).reports;

describe.each(['bn', 'en'])('%s: the today page says who took each register', (locale) => {
  it('a device register a person changed names the person, but no time', () => {
    // The register's last change can be the device's own, after the person's: a time there
    // would put the device's change next to the person's name.
    const edited = reports(locale)['takenByDeviceEdited'];
    expect(edited).toContain('{name}');
    expect(edited).not.toContain('{time}');
  });

  it('a register only the device wrote, and one a person took, keep their time', () => {
    expect(reports(locale)['takenByDevice']).toContain('{time}');
    expect(reports(locale)['takenBy']).toContain('{time}');
  });
});

describe.each([
  ['bn', 'আইডি দিয়ে'],
  ['en', 'give IDs'],
])('%s: a register held back for students not on a device', (locale, giveIds) => {
  it('tells teachers to take it by hand, owners and admins also to give IDs', () => {
    // Teachers cannot open the people screen, so their text never sends them there.
    expect(reports(locale)['deviceNotOnDevice']).not.toContain(giveIds);
    expect(reports(locale)['deviceNotOnDeviceAdmin']).toContain(giveIds);
  });
});

describe('the held-back reason picks its text by role', () => {
  it('owners and admins get the text with "give IDs", teachers the other', () => {
    const source = readFileSync(
      path.join(root, 'src/components/attendance/today-device.tsx'),
      'utf8',
    );
    expect(source).toContain("t(isAdmin ? 'deviceNotOnDeviceAdmin' : 'deviceNotOnDevice'");
  });
});

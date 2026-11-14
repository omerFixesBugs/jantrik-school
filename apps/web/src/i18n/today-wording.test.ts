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

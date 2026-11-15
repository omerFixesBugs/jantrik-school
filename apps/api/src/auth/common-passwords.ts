import { readFileSync } from 'node:fs';

/**
 * The common-password list (sprint 1 P1-D), read once on first use. The file sits next to this
 * module, in src/ and (copied by `nest build`, see nest-cli.json) in dist/. Server side only:
 * it never reaches the web bundle.
 */
let list: ReadonlySet<string> | undefined;

function load(): ReadonlySet<string> {
  const text = readFileSync(new URL('./common-passwords.txt', import.meta.url), 'utf8');
  return new Set(
    text
      .split(/\r?\n/)
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.toLowerCase()),
  );
}

/** Whether a (normalised) password is on the list, ignoring case. */
export function isCommonPassword(password: string): boolean {
  list ??= load();
  return list.has(password.toLowerCase());
}

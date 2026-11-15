import { readFileSync } from 'node:fs';

/**
 * The common-password list (sprint 1 P1-D). The file sits next to this module, in src/ and
 * (copied by `nest build`, see nest-cli.json) in dist/. PasswordSettingsService reads it at
 * start-up, so a missing file stops the API from starting rather than failing a request.
 * Server side only: it never reaches the web bundle.
 */
const LIST = new URL('./common-passwords.txt', import.meta.url);

let list: ReadonlySet<string> | undefined;

/** The list's entries, lower-cased (lines starting with # are comments). Throws if unreadable. */
export function readCommonPasswords(from: URL = LIST): ReadonlySet<string> {
  const text = readFileSync(from, 'utf8');
  return new Set(
    text
      .split(/\r?\n/)
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.toLowerCase()),
  );
}

/** Read the list now (at start-up) rather than on the first check. */
export function loadCommonPasswords(): void {
  list ??= readCommonPasswords();
}

/** Whether a (normalised) password is on the list, ignoring case. */
export function isCommonPassword(password: string): boolean {
  list ??= readCommonPasswords();
  return list.has(password.toLowerCase());
}

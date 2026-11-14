import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Redis } from 'ioredis';

/** The receiver's Redis rules, read by the production compose too (deploy/redis/start-redis.sh). */
export const INGEST_ACL_RULES_FILE = path.resolve(
  import.meta.dirname,
  '../../../../deploy/redis/ingest-user.acl',
);

/** The rules file's ACL rules, with `{prefix}` replaced (comment lines and blank lines dropped). */
export function ingestAclRules(prefix: string): string[] {
  return readFileSync(INGEST_ACL_RULES_FILE, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '')
    .join(' ')
    .split(/\s+/)
    .map((rule) => rule.replaceAll('{prefix}', prefix));
}

/**
 * Creates `user` on the test Redis with the receiver's production rules for `prefix`, plus
 * `+select` (the tests use Redis database 1; production URLs name none). Returns its password and
 * a URL that logs in as it on the same server and database as `adminUrl`.
 */
export async function createIngestAclUser(
  admin: Redis,
  adminUrl: string,
  user: string,
  prefix: string,
): Promise<{ password: string; url: string }> {
  const password = randomBytes(24).toString('hex');
  await admin.call(
    'ACL',
    'SETUSER',
    user,
    'reset',
    'on',
    `>${password}`,
    ...ingestAclRules(prefix),
    '+select',
  );
  const url = new URL(adminUrl);
  url.username = user;
  url.password = password;
  return { password, url: url.toString() };
}

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { DEVICES_QUEUE } from '../src/devices/devices.constants.js';
import { RateLimiter } from '../src/redis/rate-limiter.service.js';

// The device receiver logs in to Redis as jantrik_ingest (production compose): its own keys and
// its queue only. The rules live in one file, read here and by deploy/redis/start-redis.sh. This
// test applies them to a throwaway user on the test Redis and runs everything the receiver does
// with Redis as that user, then checks what it must not do.

const RULES_FILE = path.resolve(import.meta.dirname, '../../../deploy/redis/ingest-user.acl');

/** The rules file's ACL rules, with `{prefix}` replaced (comment lines and blank lines dropped). */
function rules(prefix: string): string[] {
  return readFileSync(RULES_FILE, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .join(' ')
    .split(/\s+/)
    .map((rule) => rule.replaceAll('{prefix}', prefix));
}

const refused = /NOPERM|no permissions/i;

describe('the receiver Redis user (deploy/redis/ingest-user.acl)', () => {
  const url = new URL(process.env['REDIS_URL'] ?? 'redis://localhost:6379/1');
  const db = Number(url.pathname.slice(1) || 0);
  const user = `jantrik_ingest_test_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const prefix = `p0acl${randomBytes(3).toString('hex')}`;
  let admin: Redis;
  let asUser: Redis;
  const queues: Queue[] = [];

  beforeAll(async () => {
    admin = new Redis(url.toString());
    // `+select` only here: the tests use Redis database 1; production URLs name none (A4).
    await admin.call(
      'ACL',
      'SETUSER',
      user,
      'reset',
      'on',
      `>${password}`,
      ...rules(prefix),
      '+select',
    );
    asUser = new Redis({
      host: url.hostname,
      port: Number(url.port || 6379),
      db,
      username: user,
      password,
      maxRetriesPerRequest: 1,
    });
    // Connected and authenticated as the user (the receiver never sends PING).
    expect(await asUser.exists(`ingest:none-${prefix}`)).toBe(0);
  });

  afterAll(async () => {
    for (const q of queues) await q.close();
    asUser.disconnect();
    await admin.call('ACL', 'DELUSER', user);
    const keys = [
      ...(await admin.keys(`${prefix}:*`)),
      ...(await admin.keys(`rl:ingest-*${prefix}*`)),
      ...(await admin.keys(`ingest:*${prefix}*`)),
    ];
    if (keys.length > 0) await admin.del(...keys);
    admin.disconnect();
  });

  const queue = (name: string, connection: Redis) => {
    const q = new Queue(name, { connection, prefix });
    queues.push(q);
    return q;
  };

  it('the production rules name no database switch and no Pub/Sub channel', () => {
    const list = rules('jantrik');
    expect(list.join(' ')).not.toMatch(/select/i);
    expect(list.some((r) => r.startsWith('&'))).toBe(false);
    expect(list).toContain('resetchannels');
    expect(list).toContain('~jantrik:devices:*');
  });

  it('runs everything the receiver does with Redis', async () => {
    const ip = `203.0.113.${prefix}`;
    const limiter = new RateLimiter(asUser);
    expect((await limiter.hit({ key: `ingest-ip:${ip}`, limit: 10, windowSec: 60 })).allowed).toBe(
      true,
    );
    expect((await limiter.peek(`ingest-refused-ip:${ip}`)).count).toBe(0);
    await limiter.hit({ key: `ingest-sn:SN${prefix}:${ip}`, limit: 10, windowSec: 60 });
    await limiter.hit({ key: `ingest-sn:SN${prefix}:untrusted`, limit: 10, windowSec: 60 });
    await limiter.hit({ key: `ingest-refused-ip:${ip}`, limit: 10, windowSec: 600 });

    expect(await asUser.set(`ingest:trusted:SN${prefix}:${ip}`, '1', 'EX', 60)).toBe('OK');
    expect(await asUser.exists(`ingest:trusted:SN${prefix}:${ip}`)).toBe(1);
    const refusedList = `ingest:refused-${prefix}`;
    await asUser.multi().lpush(refusedList, '{}').ltrim(refusedList, 0, 99).exec();
    expect(await asUser.set(`ingest:refused-log:SN${prefix}`, '1', 'EX', 60, 'NX')).toBe('OK');

    const job = await queue(DEVICES_QUEUE, asUser).add('process-punches', { tenantId: 't' });
    // Review focus 4: the worker's full-rights view sees an ordinary waiting job.
    const seen = await queue(DEVICES_QUEUE, admin).getJob(job.id!);
    expect(await seen?.getState()).toBe('waiting');
    expect(seen?.data).toEqual({ tenantId: 't' });
  });

  it.each([
    ['FLUSHALL', () => asUser.flushall()],
    ['KEYS', () => asUser.keys('*')],
    ['CONFIG GET', () => asUser.config('GET', 'maxmemory')],
    ['another key (an OTP limit)', () => asUser.get('rl:otp-phone-day:+8801700000000')],
    ['writing another key', () => asUser.set('otp:x', '1')],
    ['ACL LIST', () => asUser.call('ACL', 'LIST')],
    ['SCRIPT FLUSH', () => asUser.script('FLUSH')],
    ['a script that flushes', () => asUser.eval("return redis.call('flushall')", 0)],
    ['a script that reads another key', () => asUser.eval("return redis.call('get', 'otp:x')", 0)],
    ['SHUTDOWN', () => asUser.call('SHUTDOWN', 'NOSAVE')],
  ])('refuses %s', async (_case, attempt) => {
    await expect(attempt()).rejects.toThrow(refused);
  });

  it('the rules refuse commands Redis may also refuse for everyone (DEBUG, MODULE, REPLICAOF)', async () => {
    // Redis answers DEBUG "not allowed" before looking at the ACL, which would hide what the
    // rules say; ACL DRYRUN asks the rules themselves.
    for (const command of [
      ['DEBUG', 'SLEEP', '0'],
      ['MODULE', 'LIST'],
      ['REPLICAOF', 'NO', 'ONE'],
      ['MIGRATE', 'h', '1', 'ingest:x', '0', '1'],
      // Server-side code that would outlive the connection, and the scripts cache.
      ['FUNCTION', 'LOAD', "#!lua name=x\nredis.register_function('f', function() return 1 end)"],
      ['FUNCTION', 'FLUSH'],
      ['SCRIPT', 'LOAD', 'return 1'],
      ['PUBLISH', 'anything', 'x'],
    ]) {
      expect(String(await admin.call('ACL', 'DRYRUN', user, ...command))).toMatch(refused);
    }
    expect(await admin.call('ACL', 'DRYRUN', user, 'GET', 'ingest:x')).toBe('OK');
  });

  it('refuses another queue (the SMS queue the worker trusts)', async () => {
    await expect(queue('sms', asUser).add('send', { smsLogId: 'x' })).rejects.toThrow(refused);
  });

  it('refuses Pub/Sub', async () => {
    const sub = asUser.duplicate();
    try {
      await expect(sub.subscribe('anything')).rejects.toThrow(refused);
    } finally {
      sub.disconnect();
    }
  });
});

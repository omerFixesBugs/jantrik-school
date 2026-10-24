import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { morningPunches, parseAt, parsePins } from './morning.js';
import { attlogLine, ZkDeviceSimulator } from './simulator.js';

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

let server: Server;
let baseUrl: string;
let seen: Seen[];
/** Scripted answers by `METHOD /path`; anything else answers `OK`. */
let replies: Record<string, { status?: number; body: string }>;

beforeEach(async () => {
  seen = [];
  replies = {};
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      const reply = replies[`${req.method} ${url.pathname}`] ?? { body: 'OK' };
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'text/plain' });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.useRealTimers();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const make = (extra: Partial<ConstructorParameters<typeof ZkDeviceSimulator>[0]> = {}) =>
  new ZkDeviceSimulator({ baseUrl, sn: 'SIM001', ...extra });

describe('handshake', () => {
  it('parses the options and adopts ATTLOGStamp', async () => {
    replies['GET /iclock/cdata'] = {
      body: 'GET OPTION FROM: SIM001\nATTLOGStamp=42\nErrorDelay=30\nDelay=10\nTransTimes=00:00;14:05\n',
    };
    const sim = make();
    const res = await sim.handshake();
    expect(res.status).toBe(200);
    expect(sim.options).toMatchObject({
      ATTLOGStamp: '42',
      Delay: '10',
      TransTimes: '00:00;14:05',
    });
    expect(sim.stamp).toBe(42);
    expect(seen[0]!.path).toBe('/iclock/cdata?SN=SIM001&options=all&pushver=2.4.1&language=69');
  });

  it('accepts the legacy Stamp key and sends no pushver when null', async () => {
    replies['GET /iclock/cdata'] = { body: 'GET OPTION FROM: SIM001\r\nStamp=7\r\n' };
    const sim = make({ pushVersion: null });
    await sim.handshake();
    expect(sim.stamp).toBe(7);
    expect(seen[0]!.path).toBe('/iclock/cdata?SN=SIM001&options=all&language=69');
  });

  it('rejects a bad first line', async () => {
    replies['GET /iclock/cdata'] = { body: 'GET OPTION FROM: OTHER\nStamp=1\n' };
    await expect(make().handshake()).rejects.toThrow(/Unexpected handshake reply/);
  });

  it('returns a non-200 answer without parsing it', async () => {
    replies['GET /iclock/cdata'] = { status: 403, body: 'no' };
    const sim = make();
    expect(await sim.handshake()).toEqual({ status: 403, body: 'no' });
    expect(sim.options).toEqual({});
  });
});

describe('attlog line and device clock', () => {
  const at = new Date('2026-10-24T02:05:09Z'); // 08:05:09 in Dhaka

  it('formats the line with tabs, in the device zone', () => {
    expect(attlogLine('12', at)).toBe('12\t2026-10-24 08:05:09\t0\t1\t0\t0\t0');
    expect(attlogLine('12', at, { out: true, verify: 15 })).toBe(
      '12\t2026-10-24 08:05:09\t1\t15\t0\t0\t0',
    );
    expect(attlogLine('12', at, { out: true, state: 4 })).toBe(
      '12\t2026-10-24 08:05:09\t4\t1\t0\t0\t0',
    );
    expect(make().attlogLine('12', at)).toBe(attlogLine('12', at));
  });

  it('applies the clock skew to the device time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T17:59:30Z')); // 23:59:30 in Dhaka
    const sim = make({ clockSkewSec: 90 });
    expect(sim.deviceNow().toISOString()).toBe('2026-10-24T18:01:00.000Z');
    // Past midnight on the device clock: the next local day.
    expect(sim.deviceTimeString(sim.deviceNow())).toBe('2026-10-25 00:01:00');
  });
});

describe('punch', () => {
  it('posts the line and increments the stamp', async () => {
    const sim = make();
    const at = new Date('2026-10-24T02:05:09Z');
    const first = await sim.punch('12', { at });
    await sim.punch('13', { at, out: true });
    expect(first).toEqual({ status: 200, body: 'OK' });
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/iclock/cdata?SN=SIM001&table=ATTLOG&Stamp=1',
    });
    expect(seen[0]!.headers['content-type']).toBe('text/plain');
    expect(seen[0]!.body.toString()).toBe('12\t2026-10-24 08:05:09\t0\t1\t0\t0\t0\n');
    expect(seen[1]!.path).toContain('Stamp=2');
    expect(seen[1]!.body.toString()).toBe('13\t2026-10-24 08:05:09\t1\t1\t0\t0\t0\n');
    expect(sim.log).toHaveLength(2);
  });

  it('continues from the stamp the handshake gave', async () => {
    replies['GET /iclock/cdata'] = { body: 'GET OPTION FROM: SIM001\nATTLOGStamp=100\n' };
    const sim = make();
    await sim.handshake();
    await sim.punch('1');
    expect(seen[1]!.path).toContain('Stamp=101');
  });

  it('sends X-Forwarded-For only when set', async () => {
    await make().ping();
    await make({ forwardedFor: '203.0.113.9' }).ping();
    expect(seen[0]!.path).toBe('/iclock/ping?SN=SIM001');
    expect(seen[0]!.headers['x-forwarded-for']).toBeUndefined();
    expect(seen[1]!.headers['x-forwarded-for']).toBe('203.0.113.9');
  });
});

describe('uploadAttlog', () => {
  it('sends many lines with LF or CRLF endings', async () => {
    const sim = make();
    await sim.uploadAttlog(['a', 'b']);
    await sim.uploadAttlog(['a', 'b'], { crlf: true });
    expect(seen[0]!.body.toString()).toBe('a\nb\n');
    expect(seen[1]!.body.toString()).toBe('a\r\nb\r\n');
    expect(seen[1]!.path).toContain('table=ATTLOG&Stamp=2');
  });
});

describe('poll', () => {
  it('does nothing on OK', async () => {
    const sim = make();
    expect(await sim.poll()).toEqual({ commands: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe('/iclock/getrequest?SN=SIM001');
  });

  it('applies commands and reports the results', async () => {
    replies['GET /iclock/getrequest'] = {
      body: [
        'C:101:DATA UPDATE USERINFO PIN=5\tName=Rahim\tPri=0',
        'C:102:DATA UPDATE USERINFO PIN=6\tName=Karim',
        'C:103:DATA DELETE USERINFO PIN=6',
        'C:104:DATA DELETE USERINFO PIN=99',
        'C:105:REBOOT',
        '',
      ].join('\n'),
    };
    const sim = make();
    const { commands } = await sim.poll(true);
    expect(commands.map((c) => [c.id, c.returnCode])).toEqual([
      ['101', 0],
      ['102', 0],
      ['103', 0],
      ['104', -10],
      ['105', -1002],
    ]);
    expect([...sim.users]).toEqual([['5', 'Rahim']]);
    expect(seen[0]!.path).toBe(
      '/iclock/getrequest?SN=SIM001&INFO=Ver 8.0.4-sim,0,0,0,127.0.0.1,10,7,15,0,111'.replace(
        / /g,
        '%20',
      ),
    );
    expect(seen[1]).toMatchObject({ method: 'POST', path: '/iclock/devicecmd?SN=SIM001' });
    expect(seen[1]!.body.toString()).toBe(
      [
        'ID=101&Return=0&CMD=DATA',
        'ID=102&Return=0&CMD=DATA',
        'ID=103&Return=0&CMD=DATA',
        'ID=104&Return=-10&CMD=DATA',
        'ID=105&Return=-1002&CMD=DATA',
      ].join('\n'),
    );
  });
});

describe('listen', () => {
  it('polls until aborted', async () => {
    const sim = make();
    const controller = new AbortController();
    let polls = 0;
    await sim.listen({
      intervalMs: 5,
      signal: controller.signal,
      onPoll: () => {
        if (++polls === 3) controller.abort();
      },
    });
    expect(polls).toBe(3);
    expect(seen.every((s) => s.path.includes('INFO='))).toBe(true);
  });
});

describe('sendBiometricPayloads', () => {
  it('hits every path with the sentinel in each body', async () => {
    const sentinel = 'SENTINEL-4f2a';
    const results = await make().sendBiometricPayloads(sentinel);
    expect(results).toHaveLength(7);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const paths = seen.map((s) => s.path.split('&Stamp')[0]);
    expect(paths).toEqual([
      '/iclock/cdata?SN=SIM001&table=OPERLOG',
      '/iclock/cdata?SN=SIM001&table=BIODATA',
      '/iclock/cdata?SN=SIM001&table=ATTPHOTO',
      '/iclock/fdata?SN=SIM001&table=ATTPHOTO',
      '/iclock/cdata?SN=SIM001&FPImage=1&PIN=1&FID=0',
      '/iclock/cdata?SN=SIM001&table=IDCARD',
      '/iclock/cdata?SN=SIM001&table=options',
    ]);
    for (const s of seen) expect(s.body.toString('latin1')).toContain(sentinel);
    const oper = seen[0]!.body.toString();
    for (const kind of ['USER ', 'FP ', 'FACE ', 'FVEIN ', 'USERPIC ', 'BIOPHOTO ', 'OPLOG ']) {
      expect(oper).toContain(`${kind}`);
    }
    expect(oper).toContain(Buffer.from(sentinel).toString('base64'));
    expect(seen[2]!.body.includes(0)).toBe(true);
  });
});

describe('morning', () => {
  const now = new Date('2026-10-24T05:00:00Z'); // 11:00 on 24 Oct in Dhaka
  const opts = { pins: parsePins('1-60'), from: '07:30', minutes: 45, now };

  it('is seeded, ordered and inside the window', () => {
    const a = morningPunches({ ...opts, seed: 3 });
    const b = morningPunches({ ...opts, seed: 3 });
    const c = morningPunches({ ...opts, seed: 4 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toHaveLength(60);
    const start = new Date('2026-10-24T01:30:00Z').getTime();
    for (const p of a) {
      expect(p.at.getTime()).toBeGreaterThanOrEqual(start);
      expect(p.at.getTime()).toBeLessThan(start + 45 * 60_000);
    }
    expect(a.map((p) => p.at.getTime())).toEqual(
      a.map((p) => p.at.getTime()).sort((x, y) => x - y),
    );
    expect(new Set(a.map((p) => p.pin)).size).toBe(60);
  });

  it('rejects bad input', () => {
    expect(() => morningPunches({ ...opts, from: '7am' })).toThrow(/HH:MM/);
    expect(() => morningPunches({ ...opts, minutes: 0 })).toThrow(/minutes/);
    expect(() => parsePins('3-1')).toThrow(/range/);
    expect(() => parsePins('1,x')).toThrow(/list/);
    expect(parsePins('4,9')).toEqual(['4', '9']);
  });
});

describe('parseAt', () => {
  const now = new Date('2026-10-24T05:00:00Z');
  it('reads HH:MM as today in the zone and a full time as given', () => {
    expect(parseAt('08:05', 'Asia/Dhaka', now).toISOString()).toBe('2026-10-24T02:05:00.000Z');
    expect(parseAt('2026-10-20 23:30:00', 'Asia/Dhaka', now).toISOString()).toBe(
      '2026-10-20T17:30:00.000Z',
    );
    expect(() => parseAt('soon', 'Asia/Dhaka', now)).toThrow(/Bad --at/);
  });
});

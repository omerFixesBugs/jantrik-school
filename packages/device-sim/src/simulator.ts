import { localDateOf, localTimeOf } from '@jantrik/shared';

export interface SimulatorOptions {
  baseUrl: string;
  sn: string;
  timeZone?: string;
  /** The device clock is the real clock plus this many seconds. */
  clockSkewSec?: number;
  /** Sent as X-Forwarded-For on every request, to look like another source address. */
  forwardedFor?: string;
  /** Null sends no pushver, like old firmware. */
  pushVersion?: string | null;
  fetchImpl?: typeof fetch;
}

export interface Exchange {
  status: number;
  body: string;
}

export interface LineOptions {
  /** The zone the device clock shows; default Asia/Dhaka. */
  timeZone?: string;
  out?: boolean;
  verify?: number;
  state?: number;
}

export interface PunchOptions extends LineOptions {
  at?: Date;
}

export interface PolledCommand {
  id: string;
  command: string;
  returnCode: number;
}

const TAB = '\t';
const DEFAULT_ZONE = 'Asia/Dhaka';

/** One ATTLOG line: PIN, time, state (0 in, 1 out), verify, then three reserved zeros. */
export function attlogLine(pin: string, at: Date, opts: LineOptions = {}): string {
  const zone = opts.timeZone ?? DEFAULT_ZONE;
  const time = `${localDateOf(at, zone)} ${localTimeOf(at, zone)}`;
  const state = opts.state ?? (opts.out ? 1 : 0);
  return [pin, time, state, opts.verify ?? 1, 0, 0, 0].join(TAB);
}

export class ZkDeviceSimulator {
  readonly users = new Map<string, string>();
  stamp = 0;
  options: Record<string, string> = {};
  readonly log: string[] = [];

  private readonly baseUrl: string;
  private readonly sn: string;
  private readonly timeZone: string;
  private readonly clockSkewSec: number;
  private readonly forwardedFor: string | undefined;
  private readonly pushVersion: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SimulatorOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.sn = opts.sn;
    this.timeZone = opts.timeZone ?? DEFAULT_ZONE;
    this.clockSkewSec = opts.clockSkewSec ?? 0;
    this.forwardedFor = opts.forwardedFor;
    this.pushVersion = opts.pushVersion === undefined ? '2.4.1' : opts.pushVersion;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  deviceNow(): Date {
    return new Date(Date.now() + this.clockSkewSec * 1000);
  }

  deviceTimeString(at: Date): string {
    return `${localDateOf(at, this.timeZone)} ${localTimeOf(at, this.timeZone)}`;
  }

  attlogLine(pin: string, at: Date, opts: LineOptions = {}): string {
    return attlogLine(pin, at, { timeZone: this.timeZone, ...opts });
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: string | Uint8Array,
  ): Promise<Exchange> {
    const headers: Record<string, string> = {};
    if (this.forwardedFor) headers['X-Forwarded-For'] = this.forwardedFor;
    if (body !== undefined) headers['Content-Type'] = 'text/plain';
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body as RequestInit['body'];
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    return { status: res.status, body: await res.text() };
  }

  private query(extra = ''): string {
    return `SN=${encodeURIComponent(this.sn)}${extra}`;
  }

  async handshake(): Promise<Exchange> {
    const pushver =
      this.pushVersion === null ? '' : `&pushver=${encodeURIComponent(this.pushVersion)}`;
    const res = await this.request(
      'GET',
      `/iclock/cdata?${this.query('&options=all')}${pushver}&language=69`,
    );
    if (res.status !== 200) return res;
    const [first, ...rest] = res.body.split(/\r?\n/);
    if (first !== `GET OPTION FROM: ${this.sn}`) {
      throw new Error(`Unexpected handshake reply: ${JSON.stringify(first ?? '')}`);
    }
    const options: Record<string, string> = {};
    for (const line of rest) {
      const eq = line.indexOf('=');
      if (eq > 0) options[line.slice(0, eq)] = line.slice(eq + 1);
    }
    this.options = options;
    const stamp = options['ATTLOGStamp'] ?? options['Stamp'];
    if (stamp !== undefined && /^\d+$/.test(stamp)) this.stamp = Number(stamp);
    return res;
  }

  async punch(pin: string, opts: PunchOptions = {}): Promise<Exchange> {
    const line = this.attlogLine(pin, opts.at ?? this.deviceNow(), opts);
    this.log.push(line);
    this.stamp += 1;
    return this.request(
      'POST',
      `/iclock/cdata?${this.query(`&table=ATTLOG&Stamp=${this.stamp}`)}`,
      `${line}\n`,
    );
  }

  /** One POST with many lines: a backlog, duplicates, or malformed lines. */
  async uploadAttlog(lines: string[], opts: { crlf?: boolean } = {}): Promise<Exchange> {
    const eol = opts.crlf ? '\r\n' : '\n';
    this.stamp += 1;
    return this.request(
      'POST',
      `/iclock/cdata?${this.query(`&table=ATTLOG&Stamp=${this.stamp}`)}`,
      lines.map((l) => `${l}${eol}`).join(''),
    );
  }

  async poll(info = false): Promise<{ commands: PolledCommand[] }> {
    const infoParam = info
      ? `&INFO=Ver 8.0.4-sim,${this.users.size},0,${this.log.length},127.0.0.1,10,7,15,0,111`
      : '';
    const res = await this.request('GET', `/iclock/getrequest?${this.query(infoParam)}`);
    const commands: PolledCommand[] = [];
    if (res.status !== 200) return { commands };
    for (const line of res.body.split(/\r?\n/)) {
      const m = /^C:([^:]+):(.*)$/.exec(line);
      if (m) commands.push({ id: m[1]!, command: m[2]!, returnCode: this.apply(m[2]!) });
    }
    if (commands.length > 0) {
      await this.request(
        'POST',
        `/iclock/devicecmd?${this.query()}`,
        commands.map((c) => `ID=${c.id}&Return=${c.returnCode}&CMD=DATA`).join('\n'),
      );
    }
    return { commands };
  }

  private apply(command: string): number {
    const update = /^DATA UPDATE USERINFO (.*)$/.exec(command);
    if (update) {
      const fields: Record<string, string> = {};
      for (const kv of update[1]!.split(TAB)) {
        const eq = kv.indexOf('=');
        if (eq > 0) fields[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      if (!fields['PIN']) return -1002;
      this.users.set(fields['PIN'], fields['Name'] ?? '');
      return 0;
    }
    const del = /^DATA DELETE USERINFO PIN=(.+)$/.exec(command);
    if (del) return this.users.delete(del[1]!.trim()) ? 0 : -10;
    return -1002;
  }

  /** Polls until aborted, waiting `intervalMs` between polls. */
  async listen(opts: {
    intervalMs: number;
    signal: AbortSignal;
    onPoll?: (commands: PolledCommand[]) => void;
  }): Promise<void> {
    const { signal } = opts;
    while (!signal.aborted) {
      const { commands } = await this.poll(true);
      opts.onPoll?.(commands);
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, opts.intervalMs);
        signal.addEventListener('abort', finish, { once: true });
      });
    }
  }

  ping(): Promise<Exchange> {
    return this.request('GET', `/iclock/ping?${this.query()}`);
  }

  /** What a careless device could send; the receiver must keep none of it. */
  async sendBiometricPayloads(
    sentinel: string,
  ): Promise<{ path: string; status: number; body: string }[]> {
    const s = sentinel;
    const row = (...parts: string[]) => parts.join(TAB);
    const cdata = (extra: string) => `/iclock/cdata?${this.query(extra)}`;
    const table = (name: string) => `&table=${name}&Stamp=${this.stamp}`;
    const photo = Buffer.concat([
      Buffer.from(`PIN=20261024080000-1\nSN=${this.sn}\nsize=${s.length}\nCMD=uploadphoto\0`),
      Buffer.from(`JFIF-${s}-bytes`),
    ]);
    const oplog = [
      row(
        'USER PIN=1',
        `Name=${s}`,
        'Pri=0',
        `Passwd=${s}`,
        `Card=${s}`,
        'Grp=1',
        'TZ=0000000000000000',
        'Verify=0',
        'ViceCard=',
      ),
      row('FP PIN=1', 'FID=0', 'Size=8', 'Valid=1', `TMP=${Buffer.from(s).toString('base64')}`),
      row('FACE PIN=1', 'FID=0', 'SIZE=8', 'VALID=1', `TMP=${s}`),
      row('FVEIN Pin=1', 'FID=0', 'Index=0', 'Size=8', 'Valid=1', `Tmp=${s}`),
      row('USERPIC PIN=1', 'FileName=1.jpg', 'Size=8', `Content=${s}`),
      row('BIOPHOTO PIN=1', 'FileName=1.jpg', 'Type=9', 'Size=8', `Content=${s}`),
      row('OPLOG 4', '0', '2026-10-24 08:00:00', '0', '0', '0', '0'),
    ];
    const biodata = row(
      'BIODATA Pin=1',
      'No=0',
      'Index=0',
      'Valid=1',
      'Duress=0',
      'Type=1',
      'MajorVer=10',
      'MinorVer=0',
      'Format=0',
      `Tmp=${s}`,
    );
    const requests: { path: string; body: string | Uint8Array }[] = [
      { path: cdata(table('OPERLOG')), body: `${oplog.join('\n')}\n` },
      { path: cdata(table('BIODATA')), body: `${biodata}\n` },
      { path: cdata(table('ATTPHOTO')), body: photo },
      { path: `/iclock/fdata?${this.query('&table=ATTPHOTO')}`, body: photo },
      { path: cdata('&FPImage=1&PIN=1&FID=0'), body: `FPImage-${s}` },
      { path: cdata(table('IDCARD')), body: `${row('IDCARD PIN=1', `FPTemplate1=${s}`)}\n` },
      { path: cdata('&table=options'), body: `~DeviceName=${s},FWVersion=1` },
    ];
    const results: { path: string; status: number; body: string }[] = [];
    for (const r of requests) {
      results.push({ path: r.path, ...(await this.request('POST', r.path, r.body)) });
    }
    return results;
  }
}

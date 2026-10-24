import { isIP } from 'node:net';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEVICE_ONLINE_WINDOW_MS,
  commandLine,
  handshakeOptions,
  interpretPunch,
  localTimeOf,
  nextClockOffset,
  outsideHours,
  parseAttlog,
  parseDeviceCmdResults,
  parseInfo,
  punchDirection,
  wallClockToUtc,
  type DeviceDirection,
  type IsoDate,
  type PunchDirection,
  type PunchFlag,
} from '@jantrik/shared';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { Clock } from '../common/clock.js';
import type { Env } from '../config/env.js';
import {
  DEVICES_QUEUE,
  PROCESS_PUNCHES_JOB,
  processPunchesJobId,
  type ProcessPunchesJob,
} from '../devices/devices.constants.js';
import { RateLimiter } from '../redis/rate-limiter.service.js';
import { REDIS } from '../redis/redis.constants.js';
import { IngestPrismaService } from './ingest-prisma.service.js';

const SERIAL_RE = /^[A-Za-z0-9]{6,32}$/;
const PUSH_VERSION_RE = /^[0-9.]{1,16}$/;
/** What the handshake echoes back (handshakeOptions); anything else is not stored. */
const STAMP_RE = /^[1-9]\d{0,18}$/;
/** Commands sent per getrequest (the protocol allows 200). */
const COMMANDS_PER_POLL = 20;
/** ingest_command_results takes at most this many answers. */
const MAX_COMMAND_RESULTS = 200;
const INT32 = 2 ** 31;
/** Recent refusals kept for the platform admins (`LRANGE ingest:refused`). */
const REFUSED_LIST = 'ingest:refused';
const REFUSED_LIST_MAX = 500;
const REFUSAL_WINDOW_SEC = 600;

/** An accepted device as ingest_resolve describes it, with the request's address and time. */
export interface IngestDevice {
  sn: string;
  ip: string | null;
  now: Date;
  timeZone: string;
  direction: DeviceDirection;
  attlogStamp: string | null;
  clockOffsetSec: number | null;
  clockSamples: number[];
  registeredOn: IsoDate;
  hoursStart: string;
  hoursEnd: string;
  previousSeenAt: Date | null;
  /** The device trusts this address: only then does it get and answer commands. */
  ipTrusted: boolean;
}

export type Admission =
  | { kind: 'accepted'; device: IngestDevice }
  | { kind: 'limited'; retryAfter: number }
  | { kind: 'bad-serial' }
  | { kind: 'refused' };

interface ResolveRow {
  accepted: boolean;
  refusal: string | null;
  time_zone: string | null;
  direction: DeviceDirection | null;
  attlog_stamp: string | null;
  clock_offset_sec: number | null;
  clock_samples: number[] | null;
  registered_on: string | null;
  hours_start: string | null;
  hours_end: string | null;
  previous_seen_at: Date | null;
  ip_trusted: boolean | null;
}

interface PunchRow {
  device_user_id: string;
  device_time: string;
  punched_at: string;
  local_date: IsoDate;
  verify_type: number | null;
  state: number | null;
  direction: PunchDirection;
  flags: PunchFlag[];
}

/**
 * The client address for limits, logs and the database: IPv4-mapped IPv6 (`::ffff:a.b.c.d`, how
 * a dual-stack socket shows an IPv4 device) as plain IPv4, so one device is one address. Null when
 * it is not an address at all (a forwarded header can carry anything).
 */
export function clientAddress(ip: string | undefined): string | null {
  if (!ip) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  const address = mapped ? mapped[1]! : ip;
  return isIP(address) && !address.includes('%') ? address : null;
}

/**
 * What the limits count by: an IPv4 address as it is, an IPv6 one by its /64 (a host or home
 * network usually holds a whole /64, so counting single addresses would be trivial to dodge). The
 * full address still goes to the database and the logs.
 */
export function addressBucket(ip: string | null): string {
  if (ip === null) return 'unknown';
  if (isIP(ip) !== 6) return ip;
  return `${ipv6Groups(ip).slice(0, 4).join(':')}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address, lower-case hex without leading zeros. */
function ipv6Groups(ip: string): string[] {
  let text = ip.toLowerCase();
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const zeros = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right].map((g) => parseInt(g, 16).toString(16));
}

/**
 * The ZKTeco push protocol's logic: limits, the serial number check, the database's answer
 * (only through the four ingest_* functions) and the shared rules. No bodies or query strings
 * are ever logged. The controller does the HTTP.
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger('DeviceReceiver');
  private readonly limits: {
    perIp: number;
    perDevice: number;
    untrustedPerDevice: number;
    refusedPerIp: number;
  };

  constructor(
    config: ConfigService<Env, true>,
    private readonly db: IngestPrismaService,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectQueue(DEVICES_QUEUE) private readonly queue: Queue<ProcessPunchesJob>,
  ) {
    this.limits = {
      perIp: config.get('INGEST_PER_IP_PER_MIN', { infer: true }),
      perDevice: config.get('INGEST_PER_DEVICE_PER_MIN', { infer: true }),
      untrustedPerDevice: config.get('INGEST_PER_DEVICE_ALL_PER_MIN', { infer: true }),
      refusedPerIp: config.get('INGEST_REFUSED_PER_IP_PER_10MIN', { infer: true }),
    };
  }

  /**
   * Every request starts here, in this order: the per-address limit, the brake on addresses that
   * keep sending refused serials (no database call), the serial number's form (no database call),
   * the per-device limit, ingest_resolve, then the untrusted budget. A serial number has a share
   * per address (an IPv6 /64), so requests from elsewhere cannot use up the real device's. The
   * addresses the device does not trust also share one budget per serial number, so rotating
   * addresses cannot multiply their shares; a trusted address is never charged to it, so they
   * cannot starve the device either. `info` (getrequest) and `pushVersion` (handshake) are
   * recorded on the device; ingest_resolve records the address and says whether it is trusted.
   */
  async admit(input: {
    ip: string | null;
    sn: string | undefined;
    info?: string | undefined;
    pushVersion?: string | undefined;
  }): Promise<Admission> {
    const ip = input.ip;
    const bucket = addressBucket(ip);
    const perIp = await this.limiter.hit({
      key: `ingest-ip:${bucket}`,
      limit: this.limits.perIp,
      windowSec: 60,
    });
    if (!perIp.allowed) return { kind: 'limited', retryAfter: perIp.retryAfter };
    const refusals = await this.limiter.peek(`ingest-refused-ip:${bucket}`);
    if (refusals.count >= this.limits.refusedPerIp) {
      return { kind: 'limited', retryAfter: refusals.retryAfter };
    }
    if (input.sn === undefined || !SERIAL_RE.test(input.sn)) return { kind: 'bad-serial' };
    const sn = input.sn.toUpperCase();
    const perDevice = await this.limiter.hit({
      key: `ingest-sn:${sn}:${bucket}`,
      limit: this.limits.perDevice,
      windowSec: 60,
    });
    if (!perDevice.allowed) return { kind: 'limited', retryAfter: perDevice.retryAfter };

    const now = this.clock.now();
    const { firmware, userCount } = parseInfo(input.info);
    const pushVersion =
      input.pushVersion !== undefined && PUSH_VERSION_RE.test(input.pushVersion)
        ? input.pushVersion
        : null;
    const [row] = await this.db.client.$queryRaw<ResolveRow[]>`
      SELECT accepted, refusal, time_zone, direction::text AS direction, attlog_stamp,
             clock_offset_sec, clock_samples, registered_on::text AS registered_on,
             to_char(hours_start, 'HH24:MI') AS hours_start,
             to_char(hours_end, 'HH24:MI') AS hours_end, previous_seen_at, ip_trusted
      FROM ingest_resolve(${sn}::text, ${ip}::inet, ${now}::timestamptz, ${firmware}::text,
                          ${userCount}::int, ${pushVersion}::text)`;
    if (!row?.accepted) {
      await this.recordRefusal(sn, row?.refusal ?? 'UNKNOWN', ip, now);
      return { kind: 'refused' };
    }
    if (row.ip_trusted !== true) {
      const untrusted = await this.limiter.hit({
        key: `ingest-sn:${sn}:untrusted`,
        limit: this.limits.untrustedPerDevice,
        windowSec: 60,
      });
      if (!untrusted.allowed) return { kind: 'limited', retryAfter: untrusted.retryAfter };
    }
    return {
      kind: 'accepted',
      device: {
        sn,
        ip,
        now,
        timeZone: row.time_zone!,
        direction: row.direction!,
        attlogStamp: row.attlog_stamp,
        clockOffsetSec: row.clock_offset_sec,
        clockSamples: row.clock_samples ?? [],
        registeredOn: row.registered_on!,
        hoursStart: row.hours_start!,
        hoursEnd: row.hours_end!,
        previousSeenAt: row.previous_seen_at,
        ipTrusted: row.ip_trusted === true,
      },
    };
  }

  /**
   * A refused or unknown serial: counted against the address, logged once per serial per 10
   * minutes, and kept in a short Redis list. Nothing is written to the database.
   */
  private async recordRefusal(sn: string, reason: string, ip: string | null, now: Date) {
    await this.limiter.hit({
      key: `ingest-refused-ip:${addressBucket(ip)}`,
      limit: this.limits.refusedPerIp,
      windowSec: REFUSAL_WINDOW_SEC,
    });
    const first = await this.redis.set(
      `ingest:refused-log:${sn}`,
      '1',
      'EX',
      REFUSAL_WINDOW_SEC,
      'NX',
    );
    if (first === 'OK')
      this.logger.warn(`device refused: ${sn} (${reason}) from ${ip ?? 'unknown'}`);
    await this.redis
      .multi()
      .lpush(REFUSED_LIST, JSON.stringify({ sn, reason, ip, at: now.toISOString() }))
      .ltrim(REFUSED_LIST, 0, REFUSED_LIST_MAX - 1)
      .exec();
  }

  /** The answer to `GET /iclock/cdata?options=all`. Firmware without `pushver` gets the old names. */
  handshake(device: IngestDevice, legacy: boolean): string {
    return handshakeOptions({
      sn: device.sn,
      attlogStamp: device.attlogStamp,
      timeZone: device.timeZone,
      at: device.now,
      legacy,
    });
  }

  /**
   * One ATTLOG upload. Only four fields of each line are kept (the shared parser drops the rest).
   * Returns the non-blank line count for `OK: <n>`, `too-many` (413), or null when the device was
   * refused between the two calls.
   */
  async storeAttlog(
    device: IngestDevice,
    body: string,
    stamp: string | undefined,
  ): Promise<{ lines: number } | 'too-many' | null> {
    const parsed = parseAttlog(body);
    if (parsed.tooMany) return 'too-many';
    const { now, timeZone } = device;
    const rows: PunchRow[] = [];
    for (const p of parsed.punches) {
      const punch = interpretPunch({
        deviceTime: p.deviceTime,
        receivedAt: now,
        timeZone,
        clockOffsetSec: device.clockOffsetSec,
        registeredOn: device.registeredOn,
      });
      if (punch.skip) continue;
      const flags = [...punch.flags];
      const hours = { start: device.hoursStart, end: device.hoursEnd };
      if (outsideHours(localTimeOf(punch.punchedAt, timeZone), hours)) flags.push('OUTSIDE_HOURS');
      rows.push({
        device_user_id: p.pin,
        device_time: p.deviceTime,
        punched_at: punch.punchedAt.toISOString(),
        local_date: punch.localDate,
        verify_type: p.verify,
        state: p.state,
        direction: punchDirection(device.direction, p.state),
        flags,
      });
    }

    // A device that was online uploads in real time, so its newest punch shows its clock error.
    let samples = device.clockSamples;
    let offset = device.clockOffsetSec;
    const sinceSeen =
      device.previousSeenAt === null ? null : now.getTime() - device.previousSeenAt.getTime();
    if (
      parsed.punches.length > 0 &&
      sinceSeen !== null &&
      sinceSeen >= 0 &&
      sinceSeen <= DEVICE_ONLINE_WINDOW_MS
    ) {
      const newest = parsed.punches.reduce(
        (max, p) => (p.deviceTime > max ? p.deviceTime : max),
        parsed.punches[0]!.deviceTime,
      );
      const sample = Math.round(
        (wallClockToUtc(newest, timeZone).getTime() - now.getTime()) / 1000,
      );
      ({ samples, offset } = nextClockOffset(samples, offset, sample));
    }

    const validStamp = stamp !== undefined && STAMP_RE.test(stamp) ? stamp : null;
    const [stored] = await this.db.client.$queryRaw<{ tenant_id: string; inserted: number }[]>`
      SELECT tenant_id, inserted
      FROM ingest_store_punches(${device.sn}::text, ${device.ip}::inet, ${now}::timestamptz,
                                ${JSON.stringify(rows)}::jsonb, ${validStamp}::text,
                                ${samples}::int[], ${offset}::int)`;
    if (!stored) return null;
    if (stored.inserted > 0) {
      // The institute comes from the database's answer, never from the request.
      await this.queue.add(
        PROCESS_PUNCHES_JOB,
        { tenantId: stored.tenant_id },
        {
          jobId: processPunchesJobId(stored.tenant_id),
          delay: 1000,
          removeOnComplete: true,
          removeOnFail: 50,
        },
      );
    }
    return { lines: parsed.lines };
  }

  /**
   * The answer to getrequest: the device's due commands, one per line, or `OK`. Only an address
   * the device trusts gets them (the function checks it too); anyone else just gets `OK`.
   */
  async takeCommands(device: IngestDevice): Promise<string> {
    if (!device.ipTrusted) return 'OK';
    const rows = await this.db.client.$queryRaw<{ seq: bigint; payload: string }[]>`
      SELECT seq, payload
      FROM ingest_take_commands(${device.sn}::text, ${device.ip}::inet, ${device.now}::timestamptz,
                                ${COMMANDS_PER_POLL}::int)`;
    if (rows.length === 0) return 'OK';
    return rows.map((r) => commandLine(r.seq, r.payload)).join('\n') + '\n';
  }

  /**
   * The device's `ID=<seq>&Return=<code>` answers; lines that do not fit are ignored. The
   * controller passes only those from a trusted address (the function checks it too).
   */
  async commandResults(device: IngestDevice, body: string): Promise<void> {
    if (!device.ipTrusted) return;
    const results = parseDeviceCmdResults(body)
      .filter(
        (r) =>
          Number.isSafeInteger(r.id) &&
          Number.isSafeInteger(r.returnCode) &&
          r.returnCode >= -INT32 &&
          r.returnCode < INT32,
      )
      .slice(0, MAX_COMMAND_RESULTS)
      .map((r) => ({ id: r.id, return_code: r.returnCode }));
    if (results.length === 0) return;
    await this.db.client.$queryRaw`
      SELECT ingest_command_results(${device.sn}::text, ${device.ip}::inet,
                                    ${device.now}::timestamptz, ${JSON.stringify(results)}::jsonb)`;
  }
}

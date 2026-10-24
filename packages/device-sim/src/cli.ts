import { parseArgs } from 'node:util';
import { morningPunches, parseAt, parsePins } from './morning.js';
import { attlogLine, ZkDeviceSimulator } from './simulator.js';

const USAGE = `Usage: pnpm device:sim <command> [options]

Commands:
  handshake                         print the options the server sends
  punch --pin <id> [--at <time>] [--out]
                                    send one punch; --at is HH:MM (today) or "YYYY-MM-DD HH:MM:SS"
  morning --pins <a-b|a,b,c> --from HH:MM --minutes <n> [--seed <n>]
                                    one IN punch per PIN at a seeded random time, in time order
  listen [--interval <seconds>]     handshake, then poll for commands (default 30 s); Ctrl+C stops
  biometric --sentinel <text>       send biometric-looking payloads and print the statuses

Options:
  --url <base>        receiver address (default http://localhost:4080)
  --sn <serial>       device serial number (required)
  --tz <zone>         device time zone (default Asia/Dhaka)
  --skew <seconds>    device clock = real clock + skew
  --ip <address>      sent as X-Forwarded-For
  --legacy            handshake without pushver, like old firmware
  --help              this text
`;

const BATCH = 50;

async function run(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: 'string', default: 'http://localhost:4080' },
      sn: { type: 'string' },
      tz: { type: 'string' },
      skew: { type: 'string' },
      ip: { type: 'string' },
      legacy: { type: 'boolean', default: false },
      pin: { type: 'string' },
      at: { type: 'string' },
      out: { type: 'boolean', default: false },
      pins: { type: 'string' },
      from: { type: 'string' },
      minutes: { type: 'string' },
      seed: { type: 'string' },
      interval: { type: 'string' },
      sentinel: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  if (!values.sn) throw new Error('--sn is required');
  const num = (name: string, v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
    return n;
  };
  const timeZone = values.tz ?? 'Asia/Dhaka';
  const sim = new ZkDeviceSimulator({
    baseUrl: values.url,
    sn: values.sn,
    timeZone,
    clockSkewSec: num('skew', values.skew) ?? 0,
    ...(values.ip ? { forwardedFor: values.ip } : {}),
    pushVersion: values.legacy ? null : '2.4.1',
  });

  switch (command) {
    case 'handshake': {
      const res = await sim.handshake();
      if (res.status !== 200) throw new Error(`Handshake answered ${res.status}`);
      for (const [k, v] of Object.entries(sim.options)) console.log(`${k}=${v}`);
      return;
    }
    case 'punch': {
      if (!values.pin) throw new Error('--pin is required');
      const at = values.at ? parseAt(values.at, timeZone) : sim.deviceNow();
      const res = await sim.punch(values.pin, { at, out: values.out });
      console.log(`${res.status} ${res.body.trim()}`);
      return;
    }
    case 'morning': {
      if (!values.pins || !values.from || values.minutes === undefined) {
        throw new Error('--pins, --from and --minutes are required');
      }
      const seed = num('seed', values.seed);
      const punches = morningPunches({
        pins: parsePins(values.pins),
        from: values.from,
        minutes: num('minutes', values.minutes)!,
        timeZone,
        ...(seed === undefined ? {} : { seed }),
      });
      const lines = punches.map((p) => attlogLine(p.pin, p.at, { timeZone }));
      let last = { status: 0, body: '' };
      for (let i = 0; i < lines.length; i += BATCH) {
        last = await sim.uploadAttlog(lines.slice(i, i + BATCH));
      }
      console.log(
        `Sent ${lines.length} punches. Server answered ${last.status} ${last.body.trim()}`,
      );
      return;
    }
    case 'listen': {
      const seconds = num('interval', values.interval) ?? 30;
      if (!(seconds > 0)) throw new Error('--interval must be positive');
      const res = await sim.handshake();
      if (res.status !== 200) throw new Error(`Handshake answered ${res.status}`);
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      console.log(`Listening as ${values.sn} every ${seconds} s. Ctrl+C stops.`);
      await sim.listen({
        intervalMs: seconds * 1000,
        signal: controller.signal,
        onPoll: (commands) => {
          for (const c of commands) console.log(`C:${c.id} ${c.command} -> ${c.returnCode}`);
          console.log(`Users on device: ${sim.users.size}`);
        },
      });
      return;
    }
    case 'biometric': {
      if (!values.sentinel) throw new Error('--sentinel is required');
      for (const r of await sim.sendBiometricPayloads(values.sentinel)) {
        console.log(`${r.status} ${r.path.split('?')[0]}`);
      }
      return;
    }
    default:
      throw new Error(`Unknown command "${command}". Try --help`);
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

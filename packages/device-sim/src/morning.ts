import { localDateOf, wallClockToUtc } from '@jantrik/shared';

/** A small seeded generator (mulberry32), so a "morning" run is repeatable. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `5-8` or `5,6,9` as a list of PINs. */
export function parsePins(spec: string): string[] {
  const range = /^(\d+)-(\d+)$/.exec(spec);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (to < from || to - from > 100_000) throw new Error(`Bad PIN range "${spec}"`);
    return Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
  }
  const list = spec.split(',').map((p) => p.trim());
  if (list.some((p) => !/^\d+$/.test(p))) throw new Error(`Bad PIN list "${spec}"`);
  return list;
}

export interface MorningOptions {
  pins: string[];
  /** `HH:MM`, in the device zone, today. */
  from: string;
  minutes: number;
  seed?: number;
  timeZone?: string;
  now?: Date;
}

/** One IN punch per PIN at a seeded pseudo-random time in [from, from + minutes), in time order. */
export function morningPunches(opts: MorningOptions): { pin: string; at: Date }[] {
  const timeZone = opts.timeZone ?? 'Asia/Dhaka';
  if (!/^\d{1,2}:\d{2}$/.test(opts.from)) throw new Error(`Bad time "${opts.from}", use HH:MM`);
  if (!(opts.minutes > 0)) throw new Error('--minutes must be a positive number');
  const start = wallClockToUtc(
    `${localDateOf(opts.now ?? new Date(), timeZone)} ${opts.from.padStart(5, '0')}:00`,
    timeZone,
  );
  const random = seededRandom(opts.seed ?? 1);
  return opts.pins
    .map((pin) => ({
      pin,
      at: new Date(start.getTime() + Math.floor(random() * opts.minutes * 60) * 1000),
    }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** `--at`: `HH:MM` is today at that time in the zone, otherwise a full `YYYY-MM-DD HH:MM:SS`. */
export function parseAt(value: string, timeZone: string, now = new Date()): Date {
  if (/^\d{1,2}:\d{2}$/.test(value)) {
    return wallClockToUtc(`${localDateOf(now, timeZone)} ${value.padStart(5, '0')}:00`, timeZone);
  }
  try {
    return wallClockToUtc(value, timeZone);
  } catch {
    throw new Error(`Bad --at "${value}", use HH:MM or "YYYY-MM-DD HH:MM:SS"`);
  }
}

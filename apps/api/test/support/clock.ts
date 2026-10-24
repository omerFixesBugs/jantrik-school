import { Clock } from '../../src/common/clock.js';

/** A Clock tests can set and advance. Install it with `createHarness({ clock })`. */
export class FakeClock extends Clock {
  private current: Date;

  constructor(start: Date | string = '2026-10-21T04:00:00.000Z') {
    super();
    this.current = new Date(start);
  }

  override now(): Date {
    return new Date(this.current);
  }

  set(date: Date | string): void {
    this.current = new Date(date);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

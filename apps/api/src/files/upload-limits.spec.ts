import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import {
  UPLOAD_BODY_TIMEOUT_MS,
  UPLOAD_SLOT_BACKSTOP_MS,
  UPLOADS_IN_FLIGHT,
  UPLOADS_IN_FLIGHT_PER_USER,
  UploadLimits,
} from './upload-limits.js';

// Review round 2: uploads in flight are capped per process and per person before multer reads a
// byte, and every slot is given back when the response closes (finished, aborted or failed).

function exchange() {
  const req = Object.assign(new EventEmitter(), { destroy: vi.fn(), destroyed: false });
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableFinished: false,
    socket: { writable: true } as { writable: boolean } | null,
  });
  return { req, res, asReq: req as unknown as Request, asRes: res as unknown as Response };
}

const code = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    const err = e as { getStatus(): number; getResponse(): { code: string } };
    return `${err.getStatus()} ${err.getResponse().code}`;
  }
  return 'ok';
};

describe('UploadLimits', () => {
  afterEach(() => vi.useRealTimers());

  it(`lets a person have ${UPLOADS_IN_FLIGHT_PER_USER} uploads in flight; the next gets 503 IMAGE_BUSY`, () => {
    const limits = new UploadLimits();
    const a = exchange();
    const b = exchange();
    limits.enter('u1', a.asReq, a.asRes);
    limits.enter('u1', b.asReq, b.asRes);
    const c = exchange();
    expect(code(() => limits.enter('u1', c.asReq, c.asRes))).toBe('503 IMAGE_BUSY');
    // Someone else is not affected.
    expect(code(() => limits.enter('u2', c.asReq, c.asRes))).toBe('ok');
    expect(limits.inFlight).toBe(3);
  });

  it(`caps the process at ${UPLOADS_IN_FLIGHT} uploads in flight`, () => {
    const limits = new UploadLimits();
    for (let i = 0; i < UPLOADS_IN_FLIGHT; i++) {
      const x = exchange();
      limits.enter(`user-${i}`, x.asReq, x.asRes);
    }
    const x = exchange();
    expect(code(() => limits.enter('one-more', x.asReq, x.asRes))).toBe('503 IMAGE_BUSY');
  });

  it('gives the slot back when the response closes, once, whatever ended it', () => {
    const limits = new UploadLimits();
    const a = exchange();
    limits.enter('u1', a.asReq, a.asRes);
    const b = exchange();
    limits.enter('u1', b.asReq, b.asRes);
    a.res.emit('close'); // finished
    b.res.emit('close'); // aborted by the client: the same event
    a.res.emit('close'); // a second close changes nothing
    expect(limits.inFlight).toBe(0);
    const c = exchange();
    limits.enter('u1', c.asReq, c.asRes);
    limits.enter('u1', exchange().asReq, exchange().asRes);
    expect(limits.inFlight).toBe(2);
  });

  it('takes no slot for a client already gone (its one close event was before the guard ran)', () => {
    const limits = new UploadLimits();
    // The socket closed while the global guards awaited Redis: Node destroyed the response and
    // emitted its only 'close' before enter() could listen for it.
    const gone = exchange();
    gone.res.emit('close');
    gone.res.destroyed = true;
    gone.res.socket = null;
    gone.req.destroyed = true;
    expect(() => limits.enter('u1', gone.asReq, gone.asRes)).toThrow();
    const ended = exchange();
    ended.res.writableFinished = true;
    expect(() => limits.enter('u1', ended.asReq, ended.asRes)).toThrow();
    expect(limits.inFlight).toBe(0);
    // The person can still upload twice.
    limits.enter('u1', exchange().asReq, exchange().asRes);
    limits.enter('u1', exchange().asReq, exchange().asRes);
    expect(limits.inFlight).toBe(2);
  });

  it('a slot whose close never comes is given back after the backstop', () => {
    vi.useFakeTimers();
    const limits = new UploadLimits();
    const lost = exchange();
    limits.enter('u1', lost.asReq, lost.asRes);
    lost.req.emit('end');
    vi.advanceTimersByTime(UPLOAD_SLOT_BACKSTOP_MS);
    expect(limits.inFlight).toBe(0);
    lost.res.emit('close'); // a late close changes nothing
    expect(limits.inFlight).toBe(0);
  });

  it(`drops a body that has not arrived within ${UPLOAD_BODY_TIMEOUT_MS / 1000} s; one that has is left alone`, () => {
    vi.useFakeTimers();
    const limits = new UploadLimits();
    const slow = exchange();
    const quick = exchange();
    limits.enter('u1', slow.asReq, slow.asRes);
    limits.enter('u2', quick.asReq, quick.asRes);
    quick.req.emit('end'); // its body arrived
    vi.advanceTimersByTime(UPLOAD_BODY_TIMEOUT_MS);
    expect(slow.req.destroy).toHaveBeenCalledTimes(1);
    expect(quick.req.destroy).not.toHaveBeenCalled();
    slow.res.emit('close');
    quick.res.emit('close');
    expect(limits.inFlight).toBe(0);
  });
});

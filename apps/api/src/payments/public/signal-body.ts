import type { NextFunction, Request, Response } from 'express';

/** A gateway signal's body is a few hundred bytes; anything over this is not one. */
export const SIGNAL_BODY_MAX = 16 * 1024;
/** Past this the connection is dropped instead of read to its end. */
const DRAIN_MAX = 1024 * 1024;

/** What the reader found: a form's fields, or why there are none. */
export type SignalBody =
  { ok: true; fields: Record<string, string> } | { ok: false; why: 'TOO_LARGE' | 'NOT_A_FORM' };

export type SignalRequest = Request & { signalBody?: SignalBody };

/**
 * The body of a gateway signal (POST /public/payments/…), read here before the app's own parsers:
 * `application/x-www-form-urlencoded` only, at most 16 KB, flat (no nested keys), every value a
 * string. Read to its end either way, so the app's parsers see a finished request and skip it.
 * Nothing in it is trusted; the controller keeps only the whitelisted fields (signalFields).
 */
export function signalBodyReader(req: Request, _res: Response, next: NextFunction): void {
  if (req.method !== 'POST') {
    next();
    return;
  }
  const request = req as SignalRequest;
  const chunks: Buffer[] = [];
  let size = 0;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const type = String(req.headers['content-type'] ?? '').toLowerCase();
    if (size > SIGNAL_BODY_MAX) {
      request.signalBody = { ok: false, why: 'TOO_LARGE' };
    } else if (size > 0 && !type.startsWith('application/x-www-form-urlencoded')) {
      request.signalBody = { ok: false, why: 'NOT_A_FORM' };
    } else {
      const fields: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) {
        fields[key] = value;
      }
      request.signalBody = { ok: true, fields };
    }
    req.body = {};
    next();
  };
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > DRAIN_MAX) {
      req.destroy();
      return;
    }
    if (size <= SIGNAL_BODY_MAX) chunks.push(chunk);
  });
  req.on('end', finish);
  req.on('error', () => {
    if (!done) {
      done = true;
      request.signalBody = { ok: false, why: 'TOO_LARGE' };
    }
  });
}

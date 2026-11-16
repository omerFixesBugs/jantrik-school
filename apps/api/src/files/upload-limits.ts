import { HttpException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { apiError } from '../common/api-error.js';
import { RequestContext } from '../common/request-context.js';

/** Uploads whose body may be in memory at once, per API process (5 MB each at most). */
export const UPLOADS_IN_FLIGHT = 16;
/** Per person: an admin's second tab is fine; a script holding many bodies is not. */
export const UPLOADS_IN_FLIGHT_PER_USER = 2;
/** A body not fully received by then is dropped (5 MB at 0.75 Mbps takes about 55 s). */
export const UPLOAD_BODY_TIMEOUT_MS = 60_000;
/** A slot whose response somehow never closes is given back after this anyway (a backstop). */
export const UPLOAD_SLOT_BACKSTOP_MS = 5 * 60_000;

/**
 * The client is gone, or the answer was sent: on-finished's own test (Express's dependency).
 * Then the response's one 'close' event may already be past, and a slot taken now would never
 * be given back.
 */
function finished(req: Request, res: Response): boolean {
  return (
    req.destroyed || res.destroyed || res.writableFinished || !res.socket || !res.socket.writable
  );
}

const busy = () => apiError(503, 'IMAGE_BUSY', 'Too many uploads at once; try again in a moment');

/**
 * Bounds what uploads can hold in memory (review round 2). The upload routes read their body
 * with no request transaction (@OwnTransaction), into memory (multer), so nothing else limited
 * how many bodies could be in flight. A slot is taken before multer reads a byte, refused at once
 * with 503 IMAGE_BUSY when the process or the person has too many, and given back when the
 * response closes, however it ends (sent, failed, or the client went away), or after
 * UPLOAD_SLOT_BACKSTOP_MS at the latest; a client already gone gets no slot. A body that has not
 * arrived within UPLOAD_BODY_TIMEOUT_MS is dropped, which closes the response too.
 */
@Injectable()
export class UploadLimits {
  private total = 0;
  private readonly perUser = new Map<string, number>();

  get inFlight(): number {
    return this.total;
  }

  enter(userId: string, req: Request, res: Response): void {
    // The client left while the global guards awaited Redis (review round 3): no slot at all.
    if (finished(req, res)) throw new HttpException('Client closed the request', 499);
    const mine = this.perUser.get(userId) ?? 0;
    if (this.total >= UPLOADS_IN_FLIGHT || mine >= UPLOADS_IN_FLIGHT_PER_USER) throw busy();
    this.total++;
    this.perUser.set(userId, mine + 1);
    const timer = setTimeout(() => req.destroy(), UPLOAD_BODY_TIMEOUT_MS);
    req.once('end', () => clearTimeout(timer));
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      clearTimeout(backstop);
      this.total--;
      const left = (this.perUser.get(userId) ?? 1) - 1;
      if (left > 0) this.perUser.set(userId, left);
      else this.perUser.delete(userId);
    };
    const backstop = setTimeout(release, UPLOAD_SLOT_BACKSTOP_MS);
    backstop.unref?.();
    res.once('close', release);
  }
}

/** The guard of the upload routes: runs after the token and roles guards, before multer. */
@Injectable()
export class UploadGuard implements CanActivate {
  constructor(
    private readonly limits: UploadLimits,
    private readonly context: RequestContext,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const http = ctx.switchToHttp();
    this.limits.enter(
      this.context.requirePrincipal().userId,
      http.getRequest<Request>(),
      http.getResponse<Response>(),
    );
    return true;
  }
}

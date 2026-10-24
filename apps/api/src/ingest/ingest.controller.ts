import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Env } from '../config/env.js';
import { IngestService, clientAddress, type IngestDevice } from './ingest.service.js';

/** devicecmd answers are a few short lines; 64 KB is generous. */
const MAX_DEVICECMD_BYTES = 64 * 1024;

/**
 * Every answer: plain text with a Content-Length (no chunking), never cached. Node adds the
 * `Date` header, which devices set their clocks from.
 */
export function reply(
  res: Response,
  status: number,
  text: string,
  headers: Record<string, string> = {},
): void {
  res
    .status(status)
    .set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      ...headers,
    })
    .send(text);
}

/** A query parameter given once; repeated or nested ones count as missing. */
function param(req: Request, name: string): string | undefined {
  const value = (req.query as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads the body off the socket: up to `keep` bytes are kept, the rest is read and dropped, and
 * past `max` bytes the connection is closed. `ended` is false when the body never fully arrived
 * (nothing can be answered then). `body` is null when it was longer than `keep`.
 */
async function readBody(
  req: Request,
  keep: number,
  max: number,
): Promise<{ ended: boolean; body: Buffer | null }> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > max) {
        req.socket.destroy();
        return { ended: false, body: null };
      }
      if (size <= keep) chunks.push(chunk);
      else chunks.length = 0;
    }
  } catch {
    return { ended: false, body: null };
  }
  return { ended: true, body: size <= keep ? Buffer.concat(chunks) : null };
}

/**
 * The ZKTeco push protocol (ADMS / iclock) over plain HTTP. Every route first passes
 * `IngestService.admit` (limits, serial number, the device's institute). Only `table=ATTLOG` is
 * parsed; every other upload is read off the socket and dropped unseen.
 */
@Controller('iclock')
export class IngestController {
  private readonly attlogBytes: number;
  private readonly drainBytes: number;

  constructor(
    private readonly ingest: IngestService,
    config: ConfigService<Env, true>,
  ) {
    this.attlogBytes = config.get('INGEST_MAX_ATTLOG_BYTES', { infer: true });
    this.drainBytes = config.get('INGEST_MAX_DRAIN_BYTES', { infer: true });
  }

  /** The handshake (`options=all`), or any other read of cdata (`OK`). */
  @Get('cdata')
  async cdata(@Req() req: Request, @Res() res: Response): Promise<void> {
    const handshake = param(req, 'options') === 'all';
    const pushver = param(req, 'pushver');
    const device = await this.admit(req, res, handshake ? { pushVersion: pushver } : {});
    if (!device) return;
    reply(res, 200, handshake ? this.ingest.handshake(device, !pushver) : 'OK');
  }

  /** ATTLOG uploads are stored; any other table (or an FPImage) is drained and answered `OK`. */
  @Post('cdata')
  async upload(@Req() req: Request, @Res() res: Response): Promise<void> {
    const device = await this.admit(req, res);
    if (!device) return;
    if (param(req, 'table') !== 'ATTLOG' || 'FPImage' in req.query) return this.drain(req, res);
    const { ended, body } = await readBody(
      req,
      this.attlogBytes,
      Math.max(this.attlogBytes, this.drainBytes),
    );
    if (!ended) return;
    if (body === null) return reply(res, 413, 'ERROR');
    const result = await this.ingest.storeAttlog(
      device,
      body.toString('utf8'),
      param(req, 'Stamp'),
    );
    if (result === null) return reply(res, 403, 'ERROR');
    if (result === 'too-many') return reply(res, 413, 'ERROR');
    // Every non-blank line counts, duplicates and rejected ones too, so the device moves on.
    reply(res, 200, `OK: ${result.lines}`);
  }

  /** Photos, fingerprints and the like: never parsed, stored, queued or logged. */
  @Post('fdata')
  async files(@Req() req: Request, @Res() res: Response): Promise<void> {
    const device = await this.admit(req, res);
    if (!device) return;
    await this.drain(req, res);
  }

  @Get('getrequest')
  async poll(@Req() req: Request, @Res() res: Response): Promise<void> {
    const device = await this.admit(req, res, { info: param(req, 'INFO') });
    if (!device) return;
    reply(res, 200, await this.ingest.takeCommands(device));
  }

  @Post('devicecmd')
  async commandResults(@Req() req: Request, @Res() res: Response): Promise<void> {
    const device = await this.admit(req, res);
    if (!device) return;
    const { ended, body } = await readBody(req, MAX_DEVICECMD_BYTES, this.drainBytes);
    if (!ended) return;
    if (body === null) return reply(res, 413, 'ERROR');
    await this.ingest.commandResults(device, body.toString('utf8'));
    reply(res, 200, 'OK');
  }

  @Get('ping')
  async ping(@Req() req: Request, @Res() res: Response): Promise<void> {
    const device = await this.admit(req, res);
    if (!device) return;
    reply(res, 200, 'OK');
  }

  /** The accepted device, or null once a refusal has been answered (the body is not read). */
  private async admit(
    req: Request,
    res: Response,
    extra: { info?: string | undefined; pushVersion?: string | undefined } = {},
  ): Promise<IngestDevice | null> {
    const result = await this.ingest.admit({
      ip: clientAddress(req.ip),
      sn: param(req, 'SN'),
      ...extra,
    });
    switch (result.kind) {
      case 'accepted':
        return result.device;
      case 'limited':
        reply(res, 429, 'ERROR', { 'Retry-After': String(result.retryAfter) });
        return null;
      case 'bad-serial':
        reply(res, 400, 'ERROR');
        return null;
      case 'refused':
        reply(res, 403, 'ERROR');
        return null;
    }
  }

  private async drain(req: Request, res: Response): Promise<void> {
    const { ended } = await readBody(req, 0, this.drainBytes);
    if (ended) reply(res, 200, 'OK');
  }
}

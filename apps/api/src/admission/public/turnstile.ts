import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TURNSTILE_TEST_SECRETS, type Env } from '../../config/env.js';

/** What the verifier says about a token: it passed, it did not, or Cloudflare could not answer. */
export type TurnstileVerdict = 'PASS' | 'FAIL' | 'UNAVAILABLE';

/** The token the test stand-in widget (and Cloudflare's test site keys) hand out. */
export const TURNSTILE_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5_000;

/**
 * Cloudflare Turnstile (decision P3-M): every code request and every submit needs its own token
 * (a token is single use). Fails closed: when Cloudflare cannot be reached in 5 s the answer is
 * UNAVAILABLE (503 to the caller), never a pass.
 *
 * `fake` (NODE_ENV=test only, refused elsewhere by env.ts): no network; the dummy token passes,
 * `fail` fails and `down` is unavailable, so the API and Playwright tests never call Cloudflare.
 */
@Injectable()
export class TurnstileVerifier {
  private readonly logger = new Logger(TurnstileVerifier.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  async verify(token: string, ip: string, action: string): Promise<TurnstileVerdict> {
    if (!token || token.length > 2048) return 'FAIL';
    if (this.config.get('TURNSTILE_PROVIDER', { infer: true }) === 'fake') {
      if (token === TURNSTILE_DUMMY_TOKEN) return 'PASS';
      return token === 'down' ? 'UNAVAILABLE' : 'FAIL';
    }
    const secret = this.config.get('TURNSTILE_SECRET_KEY', { infer: true });
    if (!secret) {
      this.logger.error('TURNSTILE_SECRET_KEY is not set: every admission code is refused');
      return 'UNAVAILABLE';
    }
    const body = new URLSearchParams({ secret, response: token, remoteip: ip });
    try {
      const res = await fetch(SITEVERIFY, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return 'UNAVAILABLE';
      const out = (await res.json()) as { success?: boolean; action?: string; hostname?: string };
      if (out.success !== true) return 'FAIL';
      // A real widget must report our action and the web app's host (review S2): a token solved
      // on another site or for the other step is refused. Cloudflare's test secrets (development
      // only; production refuses them) report neither.
      if (!TURNSTILE_TEST_SECRETS.includes(secret)) {
        if (out.action !== action) return 'FAIL';
        const web = this.config.get('WEB_PUBLIC_URL', { infer: true });
        if (web && out.hostname !== new URL(web).hostname) return 'FAIL';
      }
      return 'PASS';
    } catch {
      return 'UNAVAILABLE';
    }
  }
}

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { Clock } from '../../common/clock.js';

/** How long a proved phone may submit and look up applications (minutes). */
export const PHONE_TOKEN_TTL_SEC = 30 * 60;
const TYP = 'admission-phone';

interface PhoneClaims {
  typ: typeof TYP;
  /** The institute the code was sent for. */
  aud: string;
  /** The proved phone (E.164). */
  sub: string;
  exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/**
 * The applicant's proved phone, carried for 30 minutes (decision P3-N): an HS256 token whose key
 * is HKDF-SHA256(JWT_ACCESS_SECRET, "jantrik/admission-phone/v1"), so it can never verify as an
 * access token (another key and `typ`) and an access token never verifies here. Its audience is
 * the institute: A's token is refused at B.
 */
@Injectable()
export class PhoneTokens {
  private readonly key: Buffer;

  constructor(
    config: ConfigService<Env, true>,
    private readonly clock: Clock,
  ) {
    this.key = Buffer.from(
      hkdfSync(
        'sha256',
        config.get('JWT_ACCESS_SECRET', { infer: true }),
        Buffer.alloc(0),
        'jantrik/admission-phone/v1',
        32,
      ),
    );
  }

  sign(tenantId: string, phone: string): string {
    const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const claims: PhoneClaims = {
      typ: TYP,
      aud: tenantId,
      sub: phone,
      exp: Math.floor(this.clock.now().getTime() / 1000) + PHONE_TOKEN_TTL_SEC,
    };
    const payload = b64(JSON.stringify(claims));
    return `${header}.${payload}.${this.mac(`${header}.${payload}`)}`;
  }

  /** The proved phone for this institute, or null (bad, expired, another institute's, not ours). */
  verify(token: string | undefined, tenantId: string): string | null {
    if (!token || token.length > 1024) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts as [string, string, string];
    const expected = Buffer.from(this.mac(`${header}.${payload}`));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    let claims: Partial<PhoneClaims>;
    try {
      const h = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg?: string };
      if (h.alg !== 'HS256') return null;
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Partial<PhoneClaims>;
    } catch {
      return null;
    }
    if (claims.typ !== TYP || claims.aud !== tenantId || typeof claims.sub !== 'string')
      return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= this.clock.now().getTime()) {
      return null;
    }
    return claims.sub;
  }

  private mac(input: string): string {
    return createHmac('sha256', this.key).update(input).digest('base64url');
  }
}

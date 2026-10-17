import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '@jantrik/db';

export const ACCESS_TOKEN_TTL_SEC = 15 * 60;
const ISSUER = 'jantrik-api';
const AUDIENCE = 'jantrik';

/** Access token claims. See docs/auth.md. */
export interface AccessClaims {
  sub: string;
  sid: string;
  tid?: string;
  /** UI hint only; guards read current roles from Redis/DB. */
  roles?: Role[];
  typ: 'access';
}

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  signAccess(input: {
    userId: string;
    sessionId: string;
    tenantId?: string;
    roles?: Role[];
  }): Promise<string> {
    const claims: AccessClaims = {
      sub: input.userId,
      sid: input.sessionId,
      typ: 'access',
      ...(input.tenantId ? { tid: input.tenantId, roles: input.roles ?? [] } : {}),
    };
    return this.jwt.signAsync(claims, {
      algorithm: 'HS256',
      expiresIn: ACCESS_TOKEN_TTL_SEC,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  }

  /** Verified claims, or null for any invalid / expired / foreign token. */
  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const claims = await this.jwt.verifyAsync<AccessClaims>(token, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      if (
        claims.typ !== 'access' ||
        typeof claims.sub !== 'string' ||
        typeof claims.sid !== 'string'
      ) {
        return null;
      }
      return claims;
    } catch {
      return null;
    }
  }
}

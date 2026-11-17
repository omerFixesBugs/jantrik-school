import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { Clock } from '../../common/clock.js';

/** A submit sooner than this after the form opened is refused (people take longer, bots don't). */
export const FORM_MIN_FILL_MS = 15_000;
/** And later than this: the ticket is old (open the form again). */
export const FORM_MAX_AGE_MS = 2 * 3600_000;

/**
 * The form ticket (decision P3-L): `GET /public/admission/:slug` hands out `<issuedAt>.<mac>`,
 * the submit brings it back. Signed with its own key (HKDF of JWT_ACCESS_SECRET), so the time
 * cannot be forged. Tells only "too fast or too old", never which, with the honeypot's answer.
 */
@Injectable()
export class FormTickets {
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
        'jantrik/admission-form-ticket/v1',
        32,
      ),
    );
  }

  issue(slug: string): string {
    const t = String(this.clock.now().getTime());
    return `${t}.${this.mac(slug, t)}`;
  }

  /** True when the ticket is ours, for this form, and between 15 s and 2 h old. */
  check(slug: string, ticket: string | undefined): boolean {
    if (!ticket || ticket.length > 200) return false;
    const [t, sig] = ticket.split('.');
    if (!t || !sig || !/^\d{10,16}$/.test(t)) return false;
    const expected = Buffer.from(this.mac(slug, t));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
    const age = this.clock.now().getTime() - Number(t);
    return age >= FORM_MIN_FILL_MS && age <= FORM_MAX_AGE_MS;
  }

  private mac(slug: string, t: string): string {
    return createHmac('sha256', this.key).update(`${slug}:${t}`).digest('base64url');
  }
}

import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env.js';
import { TURNSTILE_DUMMY_TOKEN, TurnstileVerifier } from './turnstile.js';

const REAL = '0x4AAAAAAAexampleRealSecretKeyXYZ';
const TEST = '1x0000000000000000000000000000000AA';

const verifier = (settings: Partial<Record<keyof Env, unknown>>) =>
  new TurnstileVerifier({
    get: (key: keyof Env) => settings[key],
  } as unknown as ConfigService<Env, true>);

const answer = (body: object, ok = true) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response),
  );

afterEach(() => vi.unstubAllGlobals());

describe('TurnstileVerifier (review of P3b, S2)', () => {
  const real = {
    TURNSTILE_PROVIDER: 'cloudflare',
    TURNSTILE_SECRET_KEY: REAL,
    WEB_PUBLIC_URL: 'https://app.example.com',
  };

  it('a real secret: passes only with our action and the web app host', async () => {
    answer({ success: true, action: 'admission-otp', hostname: 'app.example.com' });
    expect(await verifier(real).verify('t', '1.2.3.4', 'admission-otp')).toBe('PASS');
    answer({ success: true, action: 'admission-submit', hostname: 'app.example.com' });
    expect(await verifier(real).verify('t', '1.2.3.4', 'admission-otp')).toBe('FAIL');
    answer({ success: true, hostname: 'app.example.com' });
    expect(await verifier(real).verify('t', '1.2.3.4', 'admission-otp')).toBe('FAIL');
    answer({ success: true, action: 'admission-otp', hostname: 'evil.example' });
    expect(await verifier(real).verify('t', '1.2.3.4', 'admission-otp')).toBe('FAIL');
    answer({ success: false });
    expect(await verifier(real).verify('t', '1.2.3.4', 'admission-otp')).toBe('FAIL');
  });

  it("Cloudflare's test secret (development) reports no action or host and passes", async () => {
    answer({ success: true, hostname: 'example.com' });
    expect(
      await verifier({ ...real, TURNSTILE_SECRET_KEY: TEST }).verify(
        't',
        '1.2.3.4',
        'admission-otp',
      ),
    ).toBe('PASS');
  });

  it('fails closed: Cloudflare unreachable or erroring, or no secret', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('timeout');
      }),
    );
    expect(await verifier(real).verify('t', '1.2.3.4', 'admission-otp')).toBe('UNAVAILABLE');
    answer({}, false);
    expect(await verifier(real).verify('t', '1.2.3.4', 'admission-otp')).toBe('UNAVAILABLE');
    expect(
      await verifier({ ...real, TURNSTILE_SECRET_KEY: undefined }).verify(
        't',
        'ip',
        'admission-otp',
      ),
    ).toBe('UNAVAILABLE');
    expect(await verifier(real).verify('', 'ip', 'admission-otp')).toBe('FAIL');
  });

  it('the fake verifier (tests): the dummy token passes, "down" is unavailable, others fail', async () => {
    const fake = verifier({ TURNSTILE_PROVIDER: 'fake' });
    expect(await fake.verify(TURNSTILE_DUMMY_TOKEN, 'ip', 'admission-otp')).toBe('PASS');
    expect(await fake.verify('down', 'ip', 'admission-otp')).toBe('UNAVAILABLE');
    expect(await fake.verify('fail', 'ip', 'admission-otp')).toBe('FAIL');
  });
});

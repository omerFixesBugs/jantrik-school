import { isPlatformOrigin } from './platform-origin.js';

// /platform/* answers only the platform's own web origin (deployment requirement 1): an XSS in
// the institute app, which CORS allows and whose site the platform cookie shares, must not be
// able to use a platform session.

const env = {
  NODE_ENV: 'production',
  DEV_LAN: false,
  PLATFORM_ORIGINS: ['https://platform.jantrik.com.bd'],
} as const;

describe('isPlatformOrigin', () => {
  it('accepts a listed origin', () => {
    expect(isPlatformOrigin('https://platform.jantrik.com.bd', env)).toBe(true);
  });

  it.each([
    ['no Origin header', undefined],
    ['an empty one', ''],
    ['"null" (sandboxed frames, file://)', 'null'],
    ["the institute app's origin", 'https://app.jantrik.com.bd'],
    ['the same host over http', 'http://platform.jantrik.com.bd'],
    ['a longer host', 'https://platform.jantrik.com.bd.evil.example'],
    ['another port', 'https://platform.jantrik.com.bd:8443'],
    ['a path after the origin', 'https://platform.jantrik.com.bd/'],
  ])('refuses %s', (_case, origin) => {
    expect(isPlatformOrigin(origin, env)).toBe(false);
  });

  it('accepts a private-LAN origin only in development with DEV_LAN', () => {
    const lan = 'http://192.168.0.200:3000';
    expect(isPlatformOrigin(lan, { ...env, NODE_ENV: 'development', DEV_LAN: true })).toBe(true);
    expect(isPlatformOrigin(lan, { ...env, NODE_ENV: 'development', DEV_LAN: false })).toBe(false);
    expect(isPlatformOrigin(lan, { ...env, NODE_ENV: 'test', DEV_LAN: true })).toBe(false);
    expect(isPlatformOrigin(lan, { ...env, NODE_ENV: 'production', DEV_LAN: true })).toBe(false);
  });
});

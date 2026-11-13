import { http, createHarness, type Harness } from './support/harness.js';
import { FakeClock } from './support/clock.js';

describe('Clock', () => {
  const clock = new FakeClock('2026-01-01T00:00:00.000Z');
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ clock });
  });
  afterAll(async () => {
    await h.close();
  });

  it('an injected service sees the fake time, and it moves on demand', async () => {
    const now = async () => (await http(h).get('/test/now').expect(200)).body.now as string;
    expect(await now()).toBe('2026-01-01T00:00:00.000Z');
    clock.advance(90_000);
    expect(await now()).toBe('2026-01-01T00:01:30.000Z');
    clock.set('2026-06-30T10:00:00.000Z');
    expect(await now()).toBe('2026-06-30T10:00:00.000Z');
  });
});

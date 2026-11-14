import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { overBudget, routeSizes } from './check-budget.mjs';

const kb = (n) => Buffer.alloc(n * 1024, 'x');

describe('the per-page size budget', () => {
  // Gzip shrinks repeated bytes to almost nothing, so the chunks here are random bytes.
  const chunk = (n) => randomBytes(n * 1024);
  const files = { 'a.js': chunk(40), 'b.js': chunk(40), 'c.js': kb(1) };
  const stats = [
    {
      route: '/dashboard',
      firstLoadChunkPaths: ['.next\\static\\chunks\\a.js', '.next/static/chunks/b.js'],
    },
    {
      route: '/fees',
      firstLoadChunkPaths: ['.next/static/chunks/a.js', '.next/static/chunks/a.js'],
    },
    { route: '/_not-found', firstLoadChunkPaths: ['.next/static/chunks/a.js'] },
  ];
  const sizes = routeSizes(stats, (rel) => files[rel.split('/').pop()]);

  it('gzips each route’s first-load chunks once, whatever the path separator', () => {
    expect(sizes.get('/dashboard')).toBeGreaterThan(sizes.get('/fees'));
    // a.js listed twice for /fees counts once.
    expect(sizes.get('/fees')).toBeCloseTo(
      routeSizes([stats[2]], (rel) => files[rel.split('/').pop()]).get('/_not-found'),
    );
  });

  it('flags a listed route over its limit, an unlisted one over the default, and a vanished route', () => {
    const fees = sizes.get('/fees');
    const problems = overBudget(sizes, {
      default: Math.floor(fees) - 1,
      routes: { '/dashboard': 1, '/gone': 10 },
    });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^\/dashboard: .* > 1 KB$/);
    expect(problems[1]).toMatch(/^\/gone: in the budget but not in the build/);
    expect(problems[2]).toMatch(/^\/fees: .* \(default limit\)$/);
  });

  it('passes when everything fits, and ignores internal routes', () => {
    expect(overBudget(sizes, { default: 10_000, routes: { '/dashboard': 10_000 } })).toEqual([]);
  });
});

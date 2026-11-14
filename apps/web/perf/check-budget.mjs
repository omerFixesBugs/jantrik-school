#!/usr/bin/env node
/**
 * Per-page JavaScript size budget (docs/design.md → Performance budget), run in CI after
 * `pnpm build`. `next build` writes `.next/diagnostics/route-bundle-stats.json`: for every route,
 * the JavaScript chunks its first load needs. This script gzips them (as the server sends them)
 * and compares the total with `perf/budget.json`:
 *
 * - `routes`: a limit in KB for each listed route (the budget pages and their neighbours);
 * - `default`: the limit for every other app route, so a new or growing page cannot slip past.
 *
 * Exit code 1 when a route is over its limit or a listed route no longer exists (renamed: update
 * the budget). `--update` rewrites the listed limits to the current size plus the headroom
 * (after a deliberate change; review the diff).
 *
 *   node perf/check-budget.mjs [--update]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

// `--dir <apps/web of another checkout>` measures that build against this budget (A/B checks).
const dirArg = process.argv.indexOf('--dir');
const WEB =
  dirArg > 0 ? path.resolve(process.argv[dirArg + 1]) : path.resolve(import.meta.dirname, '..');
const STATS = path.join(WEB, '.next/diagnostics/route-bundle-stats.json');
const BUDGET = path.join(import.meta.dirname, 'budget.json');

/** Gzipped KB of each route's first-load JavaScript (each chunk counted once per route). */
export function routeSizes(stats, readChunk) {
  const sizes = new Map();
  const cache = new Map();
  for (const { route, firstLoadChunkPaths } of stats) {
    let bytes = 0;
    for (const chunk of new Set(firstLoadChunkPaths)) {
      const rel = chunk.split('\\').join('/');
      if (!cache.has(rel)) cache.set(rel, gzipSync(readChunk(rel)).length);
      bytes += cache.get(rel);
    }
    sizes.set(route, bytes / 1024);
  }
  return sizes;
}

/** Problems with `sizes` against `budget` (empty when everything fits). */
export function overBudget(sizes, budget) {
  const problems = [];
  for (const [route, limit] of Object.entries(budget.routes)) {
    const size = sizes.get(route);
    if (size === undefined)
      problems.push(`${route}: in the budget but not in the build (renamed?)`);
    else if (size > limit) problems.push(`${route}: ${size.toFixed(1)} KB > ${limit} KB`);
  }
  for (const [route, size] of sizes) {
    if (route in budget.routes || !route.startsWith('/') || route.startsWith('/_')) continue;
    if (size > budget.default) {
      problems.push(`${route}: ${size.toFixed(1)} KB > ${budget.default} KB (default limit)`);
    }
  }
  return problems;
}

function main() {
  let stats;
  try {
    stats = JSON.parse(readFileSync(STATS, 'utf8'));
  } catch {
    console.error(`No ${path.relative(WEB, STATS)}: run \`pnpm build\` first.`);
    process.exit(1);
  }
  const budget = JSON.parse(readFileSync(BUDGET, 'utf8'));
  const sizes = routeSizes(stats, (rel) => readFileSync(path.join(WEB, rel)));

  if (process.argv.includes('--update')) {
    for (const route of Object.keys(budget.routes)) {
      const size = sizes.get(route);
      if (size !== undefined) budget.routes[route] = Math.ceil(size * (1 + budget.headroom));
    }
    writeFileSync(BUDGET, `${JSON.stringify(budget, null, 2)}\n`);
  }

  const rows = [...sizes].filter(([r]) => r.startsWith('/') && !r.startsWith('/_'));
  rows.sort((a, b) => b[1] - a[1]);
  console.log('First-load JavaScript per route (gzip):');
  for (const [route, size] of rows) {
    const limit = budget.routes[route] ?? budget.default;
    const mark = route in budget.routes ? '' : ' (default)';
    console.log(
      `  ${size.toFixed(1).padStart(6)} KB / ${String(limit).padStart(3)} KB${mark}  ${route}`,
    );
  }
  const problems = overBudget(sizes, budget);
  if (problems.length > 0) {
    console.error(`\nOver the size budget (perf/budget.json):\n  ${problems.join('\n  ')}`);
    console.error(
      'Split what the first screen does not need (next/dynamic), or raise the limit in the same PR with the reason.',
    );
    process.exit(1);
  }
  console.log('\nAll routes within the size budget.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();

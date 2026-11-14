import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMessages } from './load-messages';
import { mergeMessages, pickMessages, ROUTE_MESSAGES, type RouteArea } from './route-messages';

/*
 * Each route sends the browser only its own texts (route-messages.ts). This test follows every
 * route file's imports (page, layout, error) and collects the namespaces its client code asks for
 * with useTranslations('…'); each must be sent by the root or a layout (or page wrapper) on the
 * way to it. A missing one would show the message's key on screen instead of its text.
 */

const SRC = path.resolve(import.meta.dirname, '..');
const APP = path.join(SRC, 'app');

function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
    if (existsSync(base + ext)) return base + ext;
  }
  return null;
}

interface FileInfo {
  imports: string[];
  namespaces: string[];
  /** useTranslations() without a namespace, or with one that is not a string literal. */
  unknown: string[];
}
const infos = new Map<string, FileInfo>();
function info(file: string): FileInfo {
  const cached = infos.get(file);
  if (cached) return cached;
  const src = readFileSync(file, 'utf8');
  const imports: string[] = [];
  for (const m of src.matchAll(/(?:import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?'([^']+)'/g)) {
    const target = m[1] ? null : resolve(file, m[2]!);
    if (target) imports.push(target);
  }
  for (const m of src.matchAll(/import\(\s*'([^']+)'\s*\)/g)) {
    const target = resolve(file, m[1]!);
    if (target) imports.push(target);
  }
  const namespaces: string[] = [];
  const unknown: string[] = [];
  // The i18n plumbing itself handles messages generically.
  if (!file.startsWith(path.join(SRC, 'i18n'))) {
    for (const m of src.matchAll(/useTranslations\(\s*([^)]*)\)/g)) {
      const literal = /^'([^']+)'$/.exec(m[1]!.trim());
      if (literal) namespaces.push(literal[1]!);
      else unknown.push(`${path.relative(SRC, file)}: useTranslations(${m[1]})`);
    }
  }
  const result = { imports, namespaces, unknown };
  infos.set(file, result);
  return result;
}

function reach(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const i of info(file).imports) reach(i, seen);
  return seen;
}

/** The area a layout or page sends (`<RouteMessages area="…">`), if any. */
function areaOf(file: string): RouteArea | null {
  if (!existsSync(file)) return null;
  const m = /<RouteMessages area="([A-Za-z]+)"/.exec(readFileSync(file, 'utf8'));
  return m ? (m[1] as RouteArea) : null;
}

/** What reaches the browser on the way to `file`: the root, then each directory's layout. */
function sent(file: string): string[] {
  const out: string[] = [...ROUTE_MESSAGES.root];
  const rel = path.relative(APP, path.dirname(file));
  const dirs = rel ? rel.split(path.sep) : [];
  let dir = APP;
  for (const part of ['', ...dirs]) {
    dir = part ? path.join(dir, part) : dir;
    const area = areaOf(path.join(dir, 'layout.tsx'));
    if (area) out.push(...ROUTE_MESSAGES[area]);
  }
  if (path.basename(file) === 'page.tsx') {
    const area = areaOf(file);
    if (area) out.push(...ROUTE_MESSAGES[area]);
  }
  return out;
}

const covers = (paths: string[], ns: string) =>
  paths.some((p) => ns === p || ns.startsWith(`${p}.`));

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) routeFiles(p, out);
    else if (['page.tsx', 'layout.tsx', 'error.tsx', 'not-found.tsx'].includes(e.name)) out.push(p);
  }
  return out;
}

/** Every Bangla message, as the server loads them. */
let bn: Record<string, unknown> = {};
beforeAll(async () => {
  bn = await loadMessages('bn');
});

const pageFile = (route: string) => path.join(APP, ...route.split('/'), 'page.tsx');
const bytes = (messages: object) => Buffer.byteLength(JSON.stringify(messages));
/** The Bangla messages a page's browser receives, as the layouts merge them. */
function sentMessages(file: string) {
  return sent(file).reduce(
    (all, p) => mergeMessages(all, pickMessages(bn, [p])),
    {} as Record<string, unknown>,
  );
}

describe('each route sends the texts its client code uses', () => {
  it('every namespace a route file reaches is sent on the way to it', () => {
    const problems: string[] = [];
    for (const file of routeFiles(APP)) {
      const provided = sent(file);
      for (const reached of reach(file)) {
        const { namespaces, unknown } = info(reached);
        problems.push(...unknown);
        for (const ns of namespaces) {
          if (!covers(provided, ns)) {
            problems.push(
              `${path.relative(APP, file)} needs '${ns}' (${path.relative(SRC, reached)})`,
            );
          }
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it('every entry names messages that exist', () => {
    const missing = Object.entries(ROUTE_MESSAGES).flatMap(([area, paths]) =>
      paths
        .filter((p) => Object.keys(pickMessages(bn, [p])).length === 0)
        .map((p) => `${area}: ${p}`),
    );
    expect(missing).toEqual([]);
  });

  it('a page ships only its own texts: the budget pages carry none of the others', () => {
    const dashboard = sentMessages(pageFile('(app)/dashboard'));
    const fees = sentMessages(pageFile('(app)/fees'));
    const sheet = sentMessages(pageFile('(app)/exams/[id]/sheet'));
    // The dashboard sends no fee setup, exam setup or device people texts.
    expect(Object.keys((dashboard['fees'] as object) ?? {})).toEqual(['guardian']);
    expect(dashboard).not.toHaveProperty('exams.setup');
    expect(dashboard).not.toHaveProperty('devices.people');
    expect(dashboard).not.toHaveProperty('platformInstitutes');
    // The fee counter sends the counter, not setup or reports.
    expect(fees).toHaveProperty('fees.counter');
    expect(fees).not.toHaveProperty('fees.setup');
    expect(fees).not.toHaveProperty('fees.reports');
    // Marks entry sends its own texts, not the exam's other tabs.
    expect(sheet).toHaveProperty('exams.marks');
    expect(sheet).not.toHaveProperty('exams.results');
    // And each budget page sends well under a third of all Bangla messages (they were all sent).
    const all = bytes(bn);
    for (const route of [
      '(app)/dashboard',
      '(app)/students',
      '(app)/attendance',
      '(app)/fees',
      '(app)/exams/[id]/sheet',
    ]) {
      expect(bytes(sentMessages(pageFile(route))), route).toBeLessThan(all / 3);
    }
  });
});

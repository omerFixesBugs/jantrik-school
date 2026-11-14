import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The browser never loads zod (docs/design.md → Performance budget): it was about 35 KB of every
 * page's first JavaScript, plus every schema built at start-up. packages/shared keeps each zod
 * schema in a module apart from the values and helpers the web app uses (`*-schema.ts`,
 * `*-values.ts`) and is marked side-effect free, so the bundler leaves the schema modules out.
 *
 * This test follows every value the web app imports from @jantrik/shared to the module that
 * defines it, then through that module's own (non-type) imports, and fails if any of them
 * imports zod. The platform area (Jantrik's admins, never on a phone) may use schemas.
 */

const WEB_SRC = path.resolve(import.meta.dirname, '..');
const SHARED_SRC = path.resolve(import.meta.dirname, '../../../../packages/shared/src');
const ALLOWED = [
  /[\\/]app[\\/]\(platform\)[\\/]/,
  /[\\/]components[\\/]platform[\\/]/,
  /[\\/]lib[\\/]platform[\\/]/,
];

const sharedModules = readdirSync(SHARED_SRC).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts',
);
const sharedSource = new Map(
  sharedModules.map((f) => [f, readFileSync(path.join(SHARED_SRC, f), 'utf8')]),
);

/** Exported value name → the shared module defining it. */
function definitions(): Map<string, string> {
  const defs = new Map<string, string>();
  for (const [file, src] of sharedSource) {
    for (const m of src.matchAll(/export (?:const|function|class|let|enum)\s+([A-Za-z0-9_$]+)/g)) {
      defs.set(m[1]!, file);
    }
  }
  return defs;
}

/** The value names in `import { … } from '<from>'` statements (type-only ones left out). */
function valueImports(src: string, from: RegExp): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)) {
    if (m[1] || !from.test(m[3]!)) continue;
    for (const spec of m[2]!.split(',')) {
      const name = spec.trim();
      if (name && !name.startsWith('type ')) names.push(name.split(/\s+as\s+/)[0]!.trim());
    }
  }
  return names;
}

/** Shared modules `file` loads at run time (its non-type relative imports), transitively. */
function closure(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = sharedSource.get(file) ?? '';
  for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'\.\/([^']+)\.js'/g)) {
    const onlyTypes = m[2]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .every((s) => s.startsWith('type '));
    if (!m[1] && !onlyTypes) closure(`${m[3]}.ts`, seen);
  }
  return seen;
}

function webFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) webFiles(p, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('the browser never loads zod', () => {
  it('every value the web app imports from @jantrik/shared comes from a zod-free module', () => {
    const defs = definitions();
    const zodModules = new Set(
      [...sharedSource].filter(([, src]) => /from 'zod'/.test(src)).map(([f]) => f),
    );
    const problems: string[] = [];
    for (const file of webFiles(WEB_SRC)) {
      if (ALLOWED.some((re) => re.test(file))) continue;
      const src = readFileSync(file, 'utf8');
      for (const name of valueImports(src, /^@jantrik\/shared$/)) {
        const definedIn = defs.get(name);
        if (!definedIn) continue;
        const viaZod = [...closure(definedIn)].filter((m) => zodModules.has(m));
        if (viaZod.length > 0) {
          problems.push(
            `${path.relative(WEB_SRC, file)}: ${name} (${definedIn} → ${viaZod.join(', ')})`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('finds a zod schema imported into a page (the check works)', () => {
    const defs = definitions();
    const schemaModule = defs.get('isoDateSchema')!;
    expect(schemaModule).toBe('dates-schema.ts');
    expect(/from 'zod'/.test(sharedSource.get(schemaModule)!)).toBe(true);
    // And the helpers pages use instead are free of it.
    expect(
      [...closure(defs.get('isIsoDate')!)].some((m) => /from 'zod'/.test(sharedSource.get(m)!)),
    ).toBe(false);
  });
});

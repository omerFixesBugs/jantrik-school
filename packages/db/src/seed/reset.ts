import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { config } from 'dotenv';
import { assertLocalDevDatabase } from './reset-guard.js';

// `pnpm db:reset`: drop the local dev database, re-apply every migration, then seed templates and
// the demo tenants. Refuses anything but the local `jantrik` database (see reset-guard.ts).
// `--dry-run` runs the checks and prints the steps without changing anything.

config({ path: path.resolve(import.meta.dirname, '../../../../.env'), quiet: true });

const dryRun = process.argv.includes('--dry-run');
const packageDir = path.resolve(import.meta.dirname, '../..');

let target;
try {
  target = assertLocalDevDatabase(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const steps: { label: string; args: string[] }[] = [
  // Prisma 7's migrate reset does not run the seed; it is the next step.
  { label: 'Dropping and re-migrating', args: ['exec', 'prisma', 'migrate', 'reset', '--force'] },
  { label: 'Seeding templates and demo tenants', args: ['exec', 'tsx', 'src/seed/index.ts'] },
];

console.log(
  `${dryRun ? '[dry run] ' : ''}Resetting ${target.host}:${target.port}/${target.database}`,
);
for (const step of steps) {
  console.log(`${dryRun ? '[dry run] ' : ''}${step.label}: pnpm ${step.args.join(' ')}`);
  if (dryRun) continue;
  const result = spawnSync('pnpm', step.args, {
    cwd: packageDir,
    stdio: 'inherit',
    // pnpm is a .cmd shim on Windows, which needs a shell.
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`${step.label} failed (exit ${result.status ?? result.signal}).`);
    process.exit(result.status ?? 1);
  }
}
console.log(
  dryRun ? '[dry run] Nothing was changed.' : 'Done. Sessions were removed too: sign in again.',
);

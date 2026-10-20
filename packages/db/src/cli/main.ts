import path from 'node:path';
import { createInterface } from 'node:readline';
import { config } from 'dotenv';
import { createPrismaClient } from '../index.js';
import { CliError, operator, runPlatformAdminCli } from './platform-admin.js';

// Entry point of `pnpm platform:admin`. Reads the root .env when there is one (development);
// production passes DATABASE_MIGRATION_URL in the environment.
config({ path: path.resolve(import.meta.dirname, '../../../../.env'), quiet: true });

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

/** Ask without echoing what is typed. */
function hiddenPrompt(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(
      new CliError('No terminal to ask for the password: use --password-stdin'),
    );
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(prompt)) write.call(rl, prompt); // the prompt itself, not the typing
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const url = process.env['DATABASE_MIGRATION_URL'];
if (!url) {
  console.error('DATABASE_MIGRATION_URL is not set (the owner role connection).');
  process.exit(1);
}
const argv = process.argv.slice(2).filter((a) => a !== '--');
const fromStdin = argv.includes('--password-stdin');
const prisma = createPrismaClient(url);
try {
  await runPlatformAdminCli(
    argv.filter((a) => a !== '--password-stdin'),
    {
      prisma,
      readPassword: (prompt) => (fromStdin ? readStdin() : hiddenPrompt(prompt)),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      operator: operator(),
    },
  );
} catch (error) {
  // Usage problems are explained; anything else is reported without its details (which could
  // include connection strings).
  console.error(error instanceof CliError ? error.message : `Failed: ${(error as Error).name}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { simulateConcurrency } from './concurrency.js';
import { contextRowsToCsv, evaluateContexts, tasksetSchema } from './contexts.js';

/**
 * Command line of the SPEC §12 evaluations, run from the repository root:
 *   pnpm eval:contexts <taskset.json> [--out result.csv]
 *   pnpm eval:concurrency [--clients 4] [--steps 200] [--seed 42] [--out result.json]
 */
const FLAGS: Record<string, string[]> = { contexts: ['out'], concurrency: ['clients', 'steps', 'seed', 'out'] };
const USAGE = 'usage: eval contexts <taskset.json> [--out file] | eval concurrency [--clients n] [--steps n] [--seed n] [--out file]';

/** Positional arguments and `--name value` / `--name=value` flags. */
function parseArgs(args: string[], allowed: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [name = '', inline] = arg.slice(2).split('=', 2);
    const value = inline ?? args[++index];
    if (!allowed.includes(name) || value === undefined) throw new Error(`unknown or incomplete option ${arg}\n${USAGE}`);
    flags.set(name, value);
  }
  return { positional, flags };
}

function integerFlag(flags: Map<string, string>, name: string, fallback: number, minimum: number): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`--${name} must be an integer of at least ${minimum}`);
  return value;
}

async function run(command: string, positional: string[], flags: Map<string, string>): Promise<string> {
  if (command === 'contexts') {
    const tasksetPath = positional[0];
    if (tasksetPath === undefined) throw new Error(USAGE);
    const tasks = tasksetSchema.parse(JSON.parse(await readFile(path.resolve(tasksetPath), 'utf8')));
    return contextRowsToCsv(await evaluateContexts(tasks, () => performance.now()));
  }
  const report = simulateConcurrency({
    clients: integerFlag(flags, 'clients', 4, 1),
    steps: integerFlag(flags, 'steps', 200, 1),
    seed: integerFlag(flags, 'seed', 42, Number.MIN_SAFE_INTEGER),
  });
  return `${JSON.stringify(report, null, 2)}\n`;
}

const [command = '', ...args] = process.argv.slice(2);
try {
  const allowed = FLAGS[command];
  if (allowed === undefined) throw new Error(USAGE);
  const { positional, flags } = parseArgs(args, allowed);
  const output = await run(command, positional, flags);
  const outputPath = flags.get('out');
  if (outputPath !== undefined) await writeFile(path.resolve(outputPath), output, 'utf8');
  process.stdout.write(output);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

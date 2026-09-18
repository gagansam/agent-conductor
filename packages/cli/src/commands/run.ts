import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { parseTaskFile, runTask, type GateHandler } from '@agent-conductor/core';
import { loadAdapters } from '../adapters.js';
import { openContext, resolveRepo } from '../context.js';
import { c, consoleObserver, findingLine, printSummary } from '../print.js';

export interface RunFlags {
  repo?: string;
  verbose: boolean;
  noGates: boolean;
  skipBaseline: boolean;
  json: boolean;
}

const interactiveGate: GateHandler = async (req) => {
  process.stdout.write(`\n${c.yellow(`GATE ${req.gate}`)}  ${req.summary}\n`);
  for (const f of req.needs_human) process.stdout.write(`  ${findingLine(f)}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const a = (await rl.question('  [c]ontinue / [a]bort ? ')).trim().toLowerCase();
      if (a === 'c' || a === 'continue') return 'continue';
      if (a === 'a' || a === 'abort') return 'abort';
    }
  } finally {
    rl.close();
  }
};

export async function run(taskFile: string, flags: RunFlags): Promise<number> {
  const ctx = openContext();
  const ac = new AbortController();
  let interrupts = 0;
  const onSigint = (): void => {
    if (++interrupts === 1) {
      process.stderr.write('\nstopping: terminating workers (Ctrl-C again to force quit)\n');
      ac.abort();
    } else process.exit(130);
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);
  try {
    const repo = await resolveRepo(flags.repo);
    const task = parseTaskFile(resolve(taskFile), { repo_abs: repo, global: ctx.global });
    const needed = new Set(Object.values({ ...ctx.global.roles, ...task.routing }).map((r) => r.provider));
    const adapters = await loadAdapters(ctx.global, [...needed]);
    const gate = !flags.noGates && process.stdin.isTTY && process.stdout.isTTY ? interactiveGate : undefined;
    const summary = await runTask(task, {
      store: ctx.store,
      paths: ctx.paths,
      global: ctx.global,
      adapters,
      observer: flags.json ? () => {} : consoleObserver({ verbose: flags.verbose }),
      ...(gate ? { gate } : {}),
      signal: ac.signal,
      ...(flags.skipBaseline ? { skip_baseline: true } : {}),
    });
    if (flags.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    else printSummary(summary);
    return summary.outcome === 'converged' ? 0 : summary.outcome === 'escalated' ? 2 : 1;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigint);
    ctx.store.close();
  }
}

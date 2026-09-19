#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ConfigError, ProviderError, TaskError } from '@agent-conductor/core';
import { apply } from './commands/apply.js';
import { doctor } from './commands/doctor.js';
import { init } from './commands/init.js';
import { run } from './commands/run.js';
import { list, show } from './commands/show.js';

const USAGE = `conductor — drive coding-agent CLIs through an implement → verify → review loop

  conductor init [--repo <path>] [-y|--yes] [--force]
                                         set up ~/.conductor/config.yaml and a repo's .conductor/config.yaml,
                                         asking about each detected default (--yes takes them all)
  conductor doctor [--repo <path>]       check CLIs, capabilities, roles, repo config, instructions
           [--verify]                    run setup + every check in a fresh worktree at HEAD (no model calls)
           [--live <provider>]           run live conformance against a provider (uses quota)
           [--record <dir>]              save the live runs as offline fixtures
  conductor run <task.md> [--repo <path>] [--verbose] [--no-gates] [--no-clarify] [--skip-baseline] [--json]
           [-i|--implementer <provider>/<model>[:<effort>]]   e.g. claude/opus:high
           [-r|--reviewer <provider>/<model>[:<effort>] | none]  e.g. codex/default, or none to skip review
                                         <model> is a label from config or a raw model id
  conductor list [--json]
  conductor show [<run>] [--advice] [--json]      <run> may be the last few characters of a run id
  conductor apply [<run>] [--3way] [--force]      apply the patch to your checkout; stages nothing

State lives in $CONDUCTOR_HOME (default ~/.conductor). The conductor never commits, stages or pushes.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      implementer: { type: 'string', short: 'i' },
      reviewer: { type: 'string', short: 'r' },
      live: { type: 'string' },
      record: { type: 'string' },
      verbose: { type: 'boolean', short: 'v', default: false },
      'no-gates': { type: 'boolean', default: false },
      'skip-baseline': { type: 'boolean', default: false },
      'no-clarify': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      advice: { type: 'boolean', default: false },
      '3way': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      verify: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (!command || command === 'help' || command === '--help' || command === '-h' || values.help) return process.stdout.write(USAGE), 0;

  switch (command) {
    case 'init':
      return init({ ...(values.repo ? { repo: values.repo } : {}), yes: values.yes, force: values.force });
    case 'doctor':
      return doctor({ ...(values.repo ? { repo: values.repo } : {}), ...(values.live ? { live: values.live } : {}), ...(values.record ? { record: values.record } : {}), verify: values.verify });
    case 'run': {
      const file = positionals[0];
      if (!file) return process.stderr.write('usage: conductor run <task.md>\n'), 64;
      return run(file, { ...(values.repo ? { repo: values.repo } : {}), verbose: values.verbose, noGates: values['no-gates'], noClarify: values['no-clarify'], skipBaseline: values['skip-baseline'], json: values.json, ...(values.implementer ? { implementer: values.implementer } : {}), ...(values.reviewer ? { reviewer: values.reviewer } : {}) });
    }
    case 'list':
      return list({ json: values.json });
    case 'show':
      return show(positionals[0], { json: values.json, advice: values.advice });
    case 'apply':
      return apply(positionals[0], { threeWay: values['3way'], force: values.force });
    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      return 64;
  }
}

// node:sqlite still announces itself as experimental on some Node lines; that is noise for an operator.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') process.stderr.write(`${w.name}: ${w.message}\n`);
});

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    const expected = e instanceof ConfigError || e instanceof TaskError || e instanceof ProviderError;
    process.stderr.write(`${expected ? (e as Error).message : e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(expected ? 78 : 1);
  },
);

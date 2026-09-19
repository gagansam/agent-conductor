#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ConfigError, ProviderError, TaskError, UserError } from '@agent-conductor/core';
import { apply } from './commands/apply.js';
import { doctor } from './commands/doctor.js';
import { init } from './commands/init.js';
import { run } from './commands/run.js';
import { task, tasks } from './commands/task.js';
import { list, show } from './commands/show.js';

const USAGE = `conductor — drive coding-agent CLIs through an implement → verify → review loop

  conductor init [--repo <path>] [-y|--yes] [--force]
                                         set up ~/.conductor/config.yaml and a repo's .conductor/config.yaml,
                                         asking about each detected default (--yes takes them all)
  conductor doctor [--repo <path>]       check CLIs, capabilities, roles, repo config, instructions
           [--verify]                    run setup + every check in a fresh worktree at HEAD (no model calls)
           [--live <provider>]           run live conformance against a provider (uses quota)
           [--record <dir>]              save the live runs as offline fixtures
  conductor task ["what should change"] [--repo <name|path>] [--manual] [--save <file>] [-i <provider/model>]
                                         write a task by answering questions; a read-only model turn drafts it first
                                         (--manual skips the draft). Saved under ~/.conductor/tasks/<repo>/
  conductor tasks [--repo <name|path>]   list saved tasks
  conductor run <task.md | saved-task | "a sentence"> [--repo <name|path>] [--verbose] [--no-gates] [--no-clarify] [--skip-baseline] [--json]
           [-i|--implementer <provider>/<model>[:<effort>]]   e.g. claude/opus:high
           [-r|--reviewer <provider>/<model>[:<effort>] | none]  e.g. codex/default, or none to skip review
                                         <model> is a label from config or a raw model id
  conductor list [--json]
  conductor show [<run>] [--advice] [--json]      <run> may be the last few characters of a run id
  conductor apply [<run>] [--3way] [--force]      apply the patch to your checkout; stages nothing

Repository: --repo (a name from init, or a path), else the task's own repo:, else the repo containing this
folder, else (in a folder of repositories) you are asked which one.
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
      manual: { type: 'boolean', default: false },
      save: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (!command || command === 'help' || command === '--help' || command === '-h' || values.help) return process.stdout.write(USAGE), 0;

  switch (command) {
    case 'init':
      return init({ ...(values.repo ? { repo: values.repo } : {}), yes: values.yes, force: values.force });
    case 'doctor':
      return doctor({ ...(values.repo ? { repo: values.repo } : {}), ...(values.live ? { live: values.live } : {}), ...(values.record ? { record: values.record } : {}), verify: values.verify });
    case 'task':
      return task(positionals.join(' ') || undefined, {
        ...(values.repo ? { repo: values.repo } : {}),
        manual: values.manual,
        ...(values.save ? { save: values.save } : {}),
        yes: values.yes,
        ...(values.implementer ? { implementer: values.implementer } : {}),
      });
    case 'tasks':
      return tasks({ ...(values.repo ? { repo: values.repo } : {}), json: values.json });
    case 'run': {
      const file = positionals.join(' ');
      if (!file) return process.stderr.write('usage: conductor run <task.md | saved-task | "a sentence">\n'), 64;
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
    const expected = e instanceof ConfigError || e instanceof TaskError || e instanceof ProviderError || e instanceof UserError;
    process.stderr.write(`${expected ? (e as Error).message : e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(expected ? 78 : 1);
  },
);

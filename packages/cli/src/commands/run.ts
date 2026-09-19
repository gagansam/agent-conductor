import { resolve } from 'node:path';
import {
  applyRoleOverrides,
  loadRepoConfig,
  parseTaskFile,
  resolveRoles,
  runTask,
  type ChoicesHandler,
  type GateHandler,
  type QuestionsHandler,
  type ResolvedTarget,
} from '@agent-conductor/core';
import { loadAdapters } from '../adapters.js';
import { openContext, resolveRepo } from '../context.js';
import { c, consoleObserver, findingLine, printSummary } from '../print.js';
import { Prompter, splitList } from '../prompt.js';

export interface RunFlags {
  repo?: string;
  verbose: boolean;
  noGates: boolean;
  noClarify: boolean;
  skipBaseline: boolean;
  json: boolean;
  implementer?: string;
  reviewer?: string;
}

const out = (s = ''): void => void process.stdout.write(`${s}\n`);

const describeTarget = (t: ResolvedTarget): string =>
  `${t.provider}/${t.model_id === '' ? '(CLI default model)' : t.model_id}${t.effort ? ` effort ${t.effort}` : ''}`;

function gateHandler(p: Prompter, signal: AbortSignal): GateHandler {
  return async (req) => {
    out(`\n${c.yellow(`GATE ${req.gate}`)}  ${req.summary}`);
    for (const f of req.needs_human) out(`  ${findingLine(f)}`);
    const a = await p.ask('  [c]ontinue / [a]bort', '', (v) => (/^(c|continue|a|abort)$/i.test(v) ? undefined : 'answer c or a'));
    return signal.aborted || /^a/i.test(a) ? 'abort' : 'continue';
  };
}

function questionsHandler(p: Prompter, run: AbortSignal): QuestionsHandler {
  return async ({ stage, questions, signal }) => {
    const intro =
      stage === 'before_coding'
        ? `The implementer has ${questions.length} question(s) before it starts.`
        : `The implementer stopped mid-work to ask ${questions.length} question(s). Its work so far is kept; it continues after your answer.`;
    out(`\n${c.yellow('QUESTIONS')}  ${intro} Enter accepts its recommendation.`);
    const answers: Record<string, string> = {};
    for (const q of questions) {
      if (run.aborted || signal.aborted) break;
      out(`\n  ${c.bold(`${q.id}.`)} ${q.question}`);
      if (q.why) out(c.dim(`      why it matters: ${q.why}`));
      if (q.options.length) out(c.dim(`      options: ${q.options.join(' | ')}`));
      answers[q.id] = await p.ask('      answer', q.default, undefined, signal);
    }
    return answers;
  };
}

function choicesHandler(p: Prompter, run: AbortSignal): ChoicesHandler {
  return async ({ choices, signal }) => {
    out(`\n${c.yellow('CHOICES')}  The implementer made ${choices.length} judgment call(s) on its own. Review them before the code is reviewed.`);
    choices.forEach((d, i) => {
      out(`  ${c.bold(`${i + 1}.`)} ${d.question} ${c.dim('→')} ${d.chosen}`);
      if (d.alternatives.length) out(c.dim(`      alternatives: ${d.alternatives.join(' | ')}`));
    });
    const pick = await p.ask(
      '  overrule which? (numbers, comma-separated; Enter accepts all)',
      '',
      (v) => (splitList(v).every((n) => /^\d+$/.test(n) && Number(n) >= 1 && Number(n) <= choices.length) ? undefined : `numbers between 1 and ${choices.length}`),
      signal,
    );
    const overrules: Record<string, string> = {};
    for (const n of splitList(pick)) {
      if (run.aborted || signal.aborted) break;
      const d = choices[Number(n) - 1]!;
      const answer = await p.ask(`  ${n}. your decision`, d.alternatives[0] ?? '', (v) => (v ? undefined : 'type the decision'), signal);
      if (answer && answer !== d.chosen) overrules[d.id] = answer;
    }
    return overrules;
  };
}

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
  // One prompt for gates and questions. At a prompt the terminal is in raw mode, so Ctrl-C arrives here, not as a signal.
  const prompter = new Prompter(flags.noGates || flags.json, { onInterrupt: onSigint });
  try {
    const repo = await resolveRepo(flags.repo);
    const repoCfg = loadRepoConfig(repo);
    const parsed = parseTaskFile(resolve(taskFile), { repo_abs: repo, global: ctx.global });
    const applied = applyRoleOverrides(ctx.global, repoCfg, parsed, {
      ...(flags.implementer ? { implementer: flags.implementer } : {}),
      ...(flags.reviewer ? { reviewer: flags.reviewer } : {}),
    });
    const { global, notes } = applied;
    // Recorded in the stored task, like the role flags.
    const task = flags.noClarify ? { ...applied.task, clarify: false } : applied.task;
    const roles = resolveRoles(global, repoCfg, task.routing);
    const reviewers = roles.reviewers.slice(0, task.budget.max_reviewers);
    if (!flags.json) {
      for (const n of notes) out(`${c.yellow('note')} ${n}`);
      const review = reviewers.length ? reviewers.map(describeTarget).join(', ') : 'none (implement → verify only)';
      out(`${c.dim('roles')}  implementer ${describeTarget(roles.implementer)}  ·  reviewer ${review}`);
      if (!task.clarify) out(c.dim('clarify off: the implementer starts coding without asking questions first'));
      if (!prompter.interactive) out(c.dim('no terminal: the implementer decides everything itself; every assumption is listed at the end'));
    }
    const adapters = await loadAdapters(global, [roles.implementer.provider, ...reviewers.map((r) => r.provider)]);
    const summary = await runTask(task, {
      store: ctx.store,
      paths: ctx.paths,
      global,
      adapters,
      observer: flags.json ? () => {} : consoleObserver({ verbose: flags.verbose }),
      ...(prompter.interactive ? { gate: gateHandler(prompter, ac.signal), questions: questionsHandler(prompter, ac.signal), choices: choicesHandler(prompter, ac.signal) } : {}),
      signal: ac.signal,
      ...(flags.skipBaseline ? { skip_baseline: true } : {}),
    });
    if (flags.json) out(JSON.stringify(summary, null, 2));
    else printSummary(summary);
    return summary.outcome === 'converged' ? 0 : summary.outcome === 'escalated' ? 2 : 1;
  } finally {
    prompter.close();
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigint);
    ctx.store.close();
  }
}

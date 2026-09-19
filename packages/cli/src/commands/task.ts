import { basename, dirname, resolve } from 'node:path';
import {
  childRepos,
  draftTask,
  listSavedTasks,
  loadRepoConfig,
  parseRoleSpec,
  parseTask,
  registerRepo,
  renderTaskFile,
  repoName,
  resolveRoles,
  savedTaskPath,
  writeTaskFile,
  type AcceptanceCriterion,
  type ResolvedTarget,
  type TaskDraft,
  type TaskFileContent,
  type TaskKind,
  UserError,
} from '@agent-conductor/core';
import { loadAdapters } from '../adapters.js';
import { chooseRepo, openContext, type Context } from '../context.js';
import { c } from '../print.js';
import { Prompter, splitList } from '../prompt.js';
import { run } from './run.js';

export interface TaskFlags {
  repo?: string;
  manual: boolean;
  save?: string;
  yes: boolean;
  implementer?: string;
}

const out = (s = ''): void => void process.stdout.write(`${s}\n`);
const KINDS: TaskKind[] = ['feature', 'bugfix', 'refactor', 'chore'];

/**
 * Write a task by answering questions. A read-only model turn drafts it first
 * (description, acceptance criteria with runnable checks, files involved);
 * every field is then shown for keeping, editing or removing. Saved under
 * ~/.conductor/tasks/<repo>/ unless --save says otherwise.
 */
export async function task(request: string | undefined, flags: TaskFlags): Promise<number> {
  const ctx = openContext();
  const p = new Prompter(flags.yes);
  let runFile: string | undefined;
  try {
    const repo = await chooseRepo({ paths: ctx.paths, flag: flags.repo, prompter: p });
    const name = registerRepo(ctx.paths, repo);
    out(`${c.bold('New task')} for ${name} ${c.dim(repo)}`);

    let req = request?.trim() ?? '';
    if (!req) {
      if (!p.interactive) throw new UserError('describe the change: conductor task "…" (there is no terminal to ask)');
      req = await p.ask('\nWhat should change? (a sentence or two; "e" opens your editor)', '', (v) => (v ? undefined : 'describe the change'));
      if (req === 'e') req = p.editText('# Describe the change. Everything in this file becomes the request.\n');
    }

    let draft: TaskDraft | undefined;
    if (!flags.manual) draft = await makeDraft(ctx, repo, req, flags.implementer);

    const content = await review(p, req, draft, name);
    const file = flags.save ? resolve(flags.save) : savedTaskPath(ctx.paths, name, content.title);
    const text = renderTaskFile(content);
    parseTask(text, { repo_abs: repo, global: ctx.global });
    writeTaskFile(file, text);
    out(`\n${c.green('saved')} ${file}`);

    const saved = basename(file, '.md');
    const runnable = flags.save ? file : saved;
    if (p.interactive && (await p.confirm('\nRun it now?', true))) runFile = file;
    else out(`run it: ${c.bold(`conductor run ${runnable}`)}`);
  } finally {
    // One prompt on stdin at a time: close ours before the run opens its own.
    p.close();
    ctx.store.close();
  }
  return runFile ? run(runFile, { verbose: false, noGates: false, noClarify: false, skipBaseline: false, json: false }) : 0;
}

export async function tasks(flags: { repo?: string; json: boolean }): Promise<number> {
  const ctx = openContext();
  try {
    const filter = flags.repo ? repoName(ctx.paths, await chooseRepo({ paths: ctx.paths, flag: flags.repo })) : undefined;
    const list = listSavedTasks(ctx.paths, filter);
    if (flags.json) return out(JSON.stringify(list, null, 2)), 0;
    if (!list.length) return out(`no saved tasks${filter ? ` for ${filter}` : ''}; create one with ${c.bold('conductor task')}`), 0;
    for (const t of list) out(`${t.name.padEnd(48)} ${c.dim(t.repo.padEnd(26))} ${t.title}`);
    out(c.dim(`\nrun one with: conductor run <name>   (${ctx.paths.tasks})`));
    return 0;
  } finally {
    ctx.store.close();
  }
}

async function makeDraft(ctx: Context, repo: string, req: string, implementer: string | undefined): Promise<TaskDraft | undefined> {
  const target = drafter(ctx, repo, implementer);
  const ac = new AbortController();
  const onSigint = (): void => ac.abort();
  process.once('SIGINT', onSigint);
  out(c.dim(`\ndrafting with ${target.provider}/${target.model_id || '(CLI default model)'}: read-only, usually under a minute. Ctrl-C skips to writing it yourself.`));
  try {
    const adapters = await loadAdapters(ctx.global, [target.provider]);
    const related = childRepos(dirname(repo)).filter((r) => r !== repo);
    const res = await draftTask({
      repo_abs: repo,
      request: req,
      target,
      global: ctx.global,
      adapters,
      store: ctx.store,
      paths: ctx.paths,
      related_repos_abs: related,
      signal: ac.signal,
      onEvent: (e) => {
        if (e.kind === 'tool_call') out(c.dim(`  · ${e.summary.replaceAll(`${repo}/`, '')}`));
      },
    });
    if (res.draft) return res.draft;
    out(`${c.yellow('!')} ${ac.signal.aborted ? 'drafting skipped' : `no draft (${res.classification}${res.detail ? `: ${res.detail}` : ''}${res.errors ? `: ${res.errors.slice(0, 2).join('; ')}` : ''})`}; continuing without one. ${c.dim(`logs: ${res.log_dir}`)}`);
    return undefined;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

/** The implementer's model drafts; -i picks another, e.g. -i claude/sonnet for a cheaper draft. */
function drafter(ctx: Context, repo: string, implementer: string | undefined): ResolvedTarget {
  if (!implementer) return resolveRoles(ctx.global, loadRepoConfig(repo), {}).implementer;
  const spec = parseRoleSpec(implementer);
  const provider = ctx.global.providers[spec.provider];
  if (!provider) throw new UserError(`-i ${implementer}: unknown provider "${spec.provider}"`);
  return {
    provider: spec.provider,
    model: spec.model,
    model_id: provider.models[spec.model] ?? spec.model,
    ...(spec.effort ? { effort: spec.effort } : {}),
    slot: 'drafter',
    optional: false,
    fallback: [],
  };
}

async function review(p: Prompter, req: string, draft: TaskDraft | undefined, repo: string): Promise<TaskFileContent> {
  if (p.interactive) out(c.dim(`\n${draft ? 'Here is the draft.' : 'Write the task.'} Enter keeps the value in [brackets]; "-" removes it; or type your own.`));

  out(`\n${c.bold('Task')}`);
  const title = await p.ask('  title', draft?.title ?? oneLine(req), (v) => (v && v !== '-' ? undefined : 'a title is required'));
  const kind = (await p.ask(`  kind (${KINDS.join(' | ')})`, draft?.kind ?? 'feature', (v) => (KINDS.includes(v as TaskKind) ? undefined : `one of ${KINDS.join(', ')}`))) as TaskKind;

  let description = draft?.description ?? req;
  if (p.interactive) {
    out(c.dim(description.split('\n').map((l) => `    ${l}`).join('\n')));
    const d = await p.ask('  description (Enter keeps; "e" edits in your editor; or type a replacement)', '');
    if (d === 'e') description = p.editText(description) || description;
    else if (d && d !== '-') description = d;
  }

  out(`\n${c.bold('Acceptance criteria')} ${c.dim('each check is a command that passes only once the criterion is met')}`);
  const acceptance: AcceptanceCriterion[] = [];
  for (const a of draft?.acceptance ?? []) {
    const text = await p.ask(`  ${a.id}`, a.text);
    if (text === '-') continue;
    const current = a.check && a.check.kind !== 'manual' ? a.check.run : '';
    const check = await p.ask('      check', current);
    acceptance.push(withCheck(text, check === '-' ? '' : check));
  }
  for (;;) {
    const text = await p.ask('  add a criterion (enter to finish)', '');
    if (!text || text === '-') break;
    acceptance.push(withCheck(text, await p.ask('      check (a command; enter for none)', '')));
  }
  if (!acceptance.length) {
    acceptance.push({ id: 'AC1', text: title });
    out(c.dim('  no criteria given: the title becomes AC1, with no check of its own'));
  }
  acceptance.forEach((a, i) => (a.id = `AC${i + 1}`));

  out(`\n${c.bold('Scope')}`);
  const touch_hint = splitList(await p.ask('  files expected to change (globs, comma-separated)', draft?.touch_hint.join(', ') ?? ''));
  const context_files = splitList(await p.ask('  files the implementer should read first', draft?.context_files.join(', ') ?? ''));
  const constraints: string[] = [];
  for (const k of draft?.constraints ?? []) {
    const v = await p.ask('  constraint', k);
    if (v && v !== '-') constraints.push(v);
  }
  for (;;) {
    const v = await p.ask('  add a constraint (enter to finish)', '');
    if (!v || v === '-') break;
    constraints.push(v);
  }
  if (draft?.notes) out(c.dim(`\n  drafter's notes (the implementer asks you about these before coding): ${draft.notes}`));
  return { title, kind, repo, description, acceptance, constraints, touch_hint, context_files };
}

const withCheck = (text: string, run: string): AcceptanceCriterion => ({ id: '', text, ...(run ? { check: { kind: 'command', run, expect_exit: 0 } } : {}) });
const oneLine = (s: string): string => {
  const t = s.split('\n')[0]!.trim();
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
};

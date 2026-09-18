import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { capture, findBinary } from '@agent-conductor/adapter-api';
import {
  commandPattern,
  conductorHome,
  detectRepo,
  git,
  loadRepoConfig,
  parseRoleSpec,
  pathsFor,
  renderRepoConfig,
  repoConfigPath,
  repoRoot,
  type Paths,
  type RoleSpec,
} from '@agent-conductor/core';
import { resolveRepo } from '../context.js';
import { c } from '../print.js';
import { Prompter, splitList } from '../prompt.js';
import { verifyRepo } from './doctor.js';

export interface InitFlags {
  repo?: string;
  yes: boolean;
  force: boolean;
}

const out = (s = ''): void => void process.stdout.write(`${s}\n`);
const q = (s: string): string => JSON.stringify(s);

const CODEX_CANDIDATES = ['codex', '/Applications/Codex.app/Contents/Resources/codex'];
const PROVIDERS = ['claude', 'codex'];

const versionTuple = (v: string): number[] => (/(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1, 4) ?? ['0', '0', '0']).map(Number);
const newer = (a: string, b: string): boolean => {
  const [x, y] = [versionTuple(a), versionTuple(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/** Several Codex binaries can coexist (npm, the desktop app bundle) at very different versions. Prefer the newest. */
async function pickCodex(): Promise<{ binary: string; found: boolean; note: string }> {
  let best: { binary: string; version: string } | undefined;
  const seen: string[] = [];
  for (const cand of CODEX_CANDIDATES) {
    const abs = findBinary(cand);
    if (!abs) continue;
    const v = (await capture(abs, ['--version'], { env: { ...process.env, CODEX_HOME: '/nonexistent-conductor-probe' } })).stdout.trim();
    seen.push(`${abs} (${v || 'unknown'})`);
    if (!best || newer(v, best.version)) best = { binary: abs, version: v };
  }
  return best ? { binary: best.binary, found: true, note: seen.join(', ') } : { binary: 'codex', found: false, note: 'none found; install codex or edit this path' };
}

const roleValidator = (allowNone: boolean) => (v: string): string | undefined => {
  if (allowNone && v === 'none') return undefined;
  try {
    const s = parseRoleSpec(v);
    return PROVIDERS.includes(s.provider) ? undefined : `provider must be one of: ${PROVIDERS.join(', ')}`;
  } catch (e) {
    return (e as Error).message;
  }
};

export async function init(flags: InitFlags): Promise<number> {
  const p = new Prompter(flags.yes);
  try {
    const paths = pathsFor(conductorHome());
    if (!p.interactive && !flags.yes) out(c.dim('(not a terminal: taking the detected defaults without asking)'));
    await ensureGlobal(paths, p);

    let repo: string | undefined;
    if (flags.repo) repo = await resolveRepo(flags.repo);
    else {
      const here = await repoRoot(process.cwd()).catch(() => undefined);
      if (here && p.interactive && (await p.confirm(`\nAlso configure this repository (${here})?`, true))) repo = here;
      else out(`\nTo configure a repository: ${c.bold('conductor init --repo <path>')}`);
    }
    return repo ? await initRepo(repo, paths, p, flags.force) : 0;
  } finally {
    p.close();
  }
}

// ---- global ------------------------------------------------------------------

async function ensureGlobal(paths: Paths, p: Prompter): Promise<void> {
  if (existsSync(paths.globalConfig)) {
    out(`${c.green('✓')} global config ${paths.globalConfig} ${c.dim('(exists; left as is)')}`);
    return;
  }
  const codex = await pickCodex();
  const claude = !!findBinary('claude');
  out(`${c.bold('Global defaults')} ${c.dim(`→ ${paths.globalConfig}`)}`);
  out(c.dim(`  claude: ${claude ? 'found' : 'not found'}   codex: ${codex.found ? codex.binary : 'not found'}`));
  out(c.dim('  Roles are <provider>/<model>[:<effort>]; any run can override them with -i / -r.'));

  const implDefault = claude ? 'claude/opus:high' : 'codex/default';
  const revDefault = claude && codex.found ? 'codex/default' : claude ? 'claude/sonnet' : 'none';
  const impl = parseRoleSpec(await p.ask('  default implementer', implDefault, roleValidator(false)));
  const revAnswer = await p.ask('  default reviewer (or none)', revDefault, roleValidator(true));
  const rev = revAnswer === 'none' ? undefined : parseRoleSpec(revAnswer);

  // Aliases track the latest model; add a full name (e.g. claude-fable-5) as its own label to pin a version.
  const models: Record<string, Record<string, string>> = {
    claude: { opus: 'opus', fable: 'fable', sonnet: 'sonnet', default: '' },
    codex: { default: '' },
  };
  for (const r of [impl, rev]) if (r && !(r.model in models[r.provider]!)) models[r.provider]![r.model] = r.model;
  const role = (r: RoleSpec): string => `{ provider: ${q(r.provider)}, model: ${q(r.model)}${r.effort ? `, effort: ${q(r.effort)}` : ''} }`;
  const modelLines = (prov: string): string => Object.entries(models[prov]!).map(([k, v]) => `      ${q(k)}: ${q(v)}`).join('\n');

  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  writeFileSync(
    paths.globalConfig,
    `# agent-conductor global config, written by \`conductor init\`. See docs/14-config-reference.md.
version: 1

providers:
  claude:
    adapter: "@agent-conductor/adapter-claude"
    binary: claude
    max_concurrent: 1          # a quota decision, not a process-count decision
    models:                    # label → what the CLI accepts; "" = the CLI's own default
${modelLines('claude')}
  codex:
    adapter: "@agent-conductor/adapter-codex"
    # candidates seen: ${codex.note}
    binary: ${q(codex.binary)}
    max_concurrent: 1
    models:
${modelLines('codex')}

roles:
  implementer: ${role(impl)}
${rev ? `  reviewer: ${role(rev)}` : '  # reviewer: { provider: "codex", model: "default" }'}

loop:
  max_rounds: 3
  max_fix_attempts_per_round: 2
  max_worker_runs: 8
  max_reviewers: ${rev ? 1 : 0}
  require_cross_vendor_review: warn   # enforce | warn | off

gates:
  default: [after_review, before_apply]
`,
  );
  out(`${c.green('wrote')} ${paths.globalConfig}`);
}

// ---- repository --------------------------------------------------------------

async function initRepo(repo: string, paths: Paths, p: Prompter, force: boolean): Promise<number> {
  const file = repoConfigPath(repo);
  out(`\n${c.bold('Repository')} ${repo}`);
  if (existsSync(file) && !force && !(await p.confirm(`  ${relative(repo, file)} already exists. Replace it?`, false))) {
    out(`  left as is. ${c.dim('(--force replaces it without asking)')}`);
    return 0;
  }

  const d = await detectRepo(repo);
  out(c.dim(`  detected: ${d.stacks.join(', ') || 'nothing recognisable'}`));
  for (const w of d.warnings) out(`  ${c.yellow('!')} ${w}`);
  if (p.interactive) out(c.dim('  Enter accepts the value in [brackets]; "-" removes it; or type your own.'));

  out(`\n  ${c.bold('Setup')} ${c.dim('runs once in each fresh worktree; worktrees start without node_modules or .venv')}`);
  const setup = await p.ask('  install command', d.setup?.run ?? '');
  if (!setup || setup === '-') delete d.setup;
  else if (setup !== d.setup?.run) d.setup = { run: setup, why: 'you' };
  if (d.env_files.length) {
    const pick = await p.ask(`  copy gitignored files into each worktree? found ${d.env_files.join(', ')} ${c.dim('(comma-separated; workers can read them; enter for none)')}`, '');
    d.copy_untracked = splitList(pick);
  }

  out(`\n  ${c.bold('Checks')} ${c.dim('the definition of done: must pass before a run starts and after every change')}`);
  for (const step of [...d.steps]) {
    const a = await p.ask(`  ${step.id} ${c.dim(`(from ${step.why})`)}`, step.run);
    if (a === '-') d.steps = d.steps.filter((s) => s !== step);
    else if (a !== step.run) {
      step.run = a;
      step.why = 'you';
      if (step.kind !== 'typecheck') {
        step.parse = 'none';
        delete step.report_path;
      }
    }
  }
  for (;;) {
    const cmd = await p.ask('  add a check (command; enter to finish)', '');
    if (!cmd || cmd === '-') break;
    const base = commandPattern(cmd).replace(/\*$/, '').split(' ').pop()!.replace(/[^\w.:-]/g, '') || 'check';
    let suggestion = base;
    for (let n = 2; d.steps.some((s) => s.id === suggestion); n++) suggestion = `${base}-${n}`;
    const id = await p.ask('    name', suggestion, (v) => (d.steps.some((s) => s.id === v) ? `"${v}" is already used` : /^[\w.:-]+$/.test(v) ? undefined : 'use letters, digits, . : _ -'));
    d.steps.push({ id, kind: 'custom', run: cmd, timeout_ms: 20 * 60_000, parse: 'none', why: 'you' });
  }
  if (!d.steps.length) out(`  ${c.yellow('!')} no checks: runs will have nothing to verify against`);

  out(`\n  ${c.bold('Instructions')} ${c.dim("committed markdown, inlined identically into every worker's context")}`);
  d.instruction_sources = splitList(await p.ask('  files (comma-separated)', d.instruction_sources.join(', ')));
  const candidates = d.instruction_candidates.filter((f) => !d.instruction_sources.includes(f));
  if (candidates.length) {
    out(c.dim('  skills in this repo that can be inlined too:'));
    candidates.forEach((f, i) => out(c.dim(`    ${i + 1}. ${f}`)));
    const pick = await p.ask('  inline which? (numbers, comma-separated; enter for none)', '', (v) =>
      splitList(v).every((n) => /^\d+$/.test(n) && Number(n) >= 1 && Number(n) <= candidates.length) ? undefined : `numbers between 1 and ${candidates.length}`,
    );
    d.instruction_sources.push(...splitList(pick).map((n) => candidates[Number(n) - 1]!));
  }
  d.instruction_candidates = d.instruction_candidates.filter((f) => !d.instruction_sources.includes(f));

  out(`\n  ${c.bold('Reproductions')} ${c.dim('where a reviewer may add failing tests that prove a finding')}`);
  d.repro_paths = splitList(await p.ask('  paths (globs, comma-separated)', d.repro_paths.join(', '), (v) => (splitList(v).length ? undefined : 'give at least one path')));

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderRepoConfig(d));
  try {
    loadRepoConfig(repo);
  } catch (e) {
    out(`\n${c.red('the written file does not validate')}: ${(e as Error).message}\n${file}`);
    return 1;
  }
  out(`\n${c.green('wrote')} ${file}`);
  for (const s of d.steps) out(c.dim(`  ${s.id.padEnd(12)} ${s.run}`));

  const tracked = (await git(repo, ['ls-files', '--error-unmatch', '.conductor/config.yaml'], { allowFail: true })).code === 0;
  if (!tracked && p.interactive && (await p.confirm("\n  Keep .conductor/ out of git? Adds it to this clone's .git/info/exclude (local only; you can still commit it later)", false))) {
    const common = resolve(repo, (await git(repo, ['rev-parse', '--git-common-dir'])).stdout.trim());
    const exclude = join(common, 'info', 'exclude');
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!current.split('\n').includes('.conductor/')) {
      mkdirSync(dirname(exclude), { recursive: true });
      appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.conductor/\n`);
    }
    out(c.dim(`  added .conductor/ to ${exclude}`));
  }

  if (d.steps.length && p.interactive && (await p.confirm('\n  Prove it now? Runs setup and every check in a fresh worktree at HEAD, no model calls', true))) {
    return (await verifyRepo(repo, paths)) ? 0 : 1;
  }
  out(`\nnext: ${c.bold(`conductor doctor --repo ${repo} --verify`)} ${c.dim('(setup + checks in a fresh worktree; no model calls)')}`);
  return 0;
}

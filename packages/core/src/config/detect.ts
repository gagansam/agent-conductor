import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerificationStep } from '../contracts/task.js';
import { git } from '../git/exec.js';

export interface DetectedStep {
  id: string;
  kind: VerificationStep['kind'];
  run: string;
  timeout_ms: number;
  parse: 'junit' | 'tsc' | 'none';
  report_path?: string;
  /** Where the command came from, shown next to it in the written file. */
  why: string;
}

export interface RepoDetection {
  /** e.g. "node (pnpm)", "python (uv)". */
  stacks: string[];
  setup?: { run: string; why: string };
  steps: DetectedStep[];
  /** Beyond what each check implies: test runners on single files, the interpreter. */
  extra_allowed_commands: string[];
  repro_paths: string[];
  /** Enabled in the written file. */
  instruction_sources: string[];
  /** Written commented out, for the operator to opt into. */
  instruction_candidates: string[];
  /** Gitignored env files found at the root; offered, never enabled by detection. */
  env_files: string[];
  /** Gitignored files the operator chose to copy into each worktree. */
  copy_untracked: string[];
  warnings: string[];
}

type Pm = 'pnpm' | 'yarn' | 'bun' | 'npm';

const MIN = 60_000;
const readText = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const NPM_PLACEHOLDER_TEST = /no test specified/;

/**
 * Read a repository's manifests and propose how to set up and verify a
 * change. Only standard, conventional commands are proposed; anything that
 * cannot be inferred is left for the operator. The result is a starting
 * point, proven or disproven by `conductor doctor --verify`.
 */
export async function detectRepo(repo: string): Promise<RepoDetection> {
  const d: RepoDetection = { stacks: [], steps: [], extra_allowed_commands: [], repro_paths: [], instruction_sources: [], instruction_candidates: [], env_files: [], copy_untracked: [], warnings: [] };
  const tracked = new Set((await git(repo, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean));
  const has = (rel: string): boolean => existsSync(join(repo, rel));
  const setups: string[] = [];
  const whys: string[] = [];

  if (has('package.json')) detectNode(repo, d, setups, whys);
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py') || has('manage.py')) detectPython(repo, d, setups, whys);
  if (has('go.mod')) {
    d.stacks.push('go');
    setups.push('go mod download');
    whys.push('go.mod');
    d.steps.push({ id: 'vet', kind: 'lint', run: 'go vet ./...', timeout_ms: 10 * MIN, parse: 'none', why: 'go.mod' });
    d.steps.push({ id: 'test', kind: 'test', run: 'go test ./...', timeout_ms: 20 * MIN, parse: 'none', why: 'go.mod' });
    d.extra_allowed_commands.push('go test*', 'go vet*', 'go build*');
  }
  if (has('Cargo.toml')) {
    d.stacks.push('rust');
    d.steps.push({ id: 'check', kind: 'typecheck', run: 'cargo check --all-targets', timeout_ms: 20 * MIN, parse: 'none', why: 'Cargo.toml' });
    d.steps.push({ id: 'test', kind: 'test', run: 'cargo test', timeout_ms: 30 * MIN, parse: 'none', why: 'Cargo.toml' });
    d.extra_allowed_commands.push('cargo check*', 'cargo test*', 'cargo build*');
  }

  // Two stacks in one repo can both want "test"; keep ids unique.
  const seen = new Map<string, number>();
  for (const s of d.steps) {
    const n = (seen.get(s.id) ?? 0) + 1;
    seen.set(s.id, n);
    if (n > 1) s.id = `${s.id}-${n}`;
  }
  if (setups.length) d.setup = { run: setups.join(' && '), why: whys.join(', ') };
  if (!d.stacks.length) d.warnings.push('no package.json, pyproject.toml, requirements.txt, go.mod or Cargo.toml at the root: add setup and verification by hand');
  else if (!d.steps.length) d.warnings.push('no checks could be inferred: add the commands that prove a change works under verification');

  for (const dir of ['test', 'tests', '__tests__', 'spec', 'e2e']) if (has(dir)) d.repro_paths.push(`${dir}/**`);
  d.repro_paths.push('**/__repro__/**');
  d.extra_allowed_commands = [...new Set(d.extra_allowed_commands)];

  detectInstructions(repo, tracked, d);
  d.env_files = readdirSync(repo)
    .filter((f) => /^\.env(\..+)?$/.test(f) && !/example|sample|template/i.test(f) && !tracked.has(f))
    .sort();
  return d;
}

function detectNode(repo: string, d: RepoDetection, setups: string[], whys: string[]): void {
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; packageManager?: string; workspaces?: unknown };
  try {
    pkg = JSON.parse(readText(join(repo, 'package.json'))) as typeof pkg;
  } catch {
    d.warnings.push('package.json is not valid JSON; skipped');
    return;
  }
  const has = (rel: string): boolean => existsSync(join(repo, rel));
  const declared = /^(pnpm|yarn|bun|npm)@/.exec(pkg.packageManager ?? '')?.[1] as Pm | undefined;
  const lock: [string, Pm][] = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']];
  const found = lock.find(([f]) => has(f));
  const pm: Pm = found?.[1] ?? declared ?? 'npm';
  const monorepo = !!pkg.workspaces || has('pnpm-workspace.yaml');
  d.stacks.push(`node (${pm}${monorepo ? ', workspaces' : ''})`);

  const install: Record<Pm, string> = {
    pnpm: 'pnpm install --frozen-lockfile --prefer-offline',
    yarn: has('.yarnrc.yml') ? 'yarn install --immutable' : 'yarn install --frozen-lockfile',
    bun: 'bun install --frozen-lockfile',
    npm: found ? 'npm ci' : 'npm install',
  };
  setups.push(install[pm]);
  whys.push(found?.[0] ?? 'package.json');
  if (!found) d.warnings.push('no lockfile: setup installs without one, so dependency versions can drift between runs');

  const run = (script: string): string => `${pm} run ${script}`;
  const exec = (bin: string): string => ({ pnpm: `pnpm exec ${bin}`, yarn: `yarn ${bin}`, bun: `bunx ${bin}`, npm: `npx --no-install ${bin}` })[pm];
  const scripts = pkg.scripts ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const tc = ['typecheck', 'type-check', 'check-types', 'types', 'tsc'].find((s) => scripts[s]);
  if (tc) d.steps.push({ id: 'typecheck', kind: 'typecheck', run: run(tc), timeout_ms: 10 * MIN, parse: 'tsc', why: `package.json scripts.${tc}` });
  else if (has('tsconfig.json') && deps.typescript) d.steps.push({ id: 'typecheck', kind: 'typecheck', run: exec('tsc --noEmit'), timeout_ms: 10 * MIN, parse: 'tsc', why: 'tsconfig.json + typescript' });

  if (scripts.lint) d.steps.push({ id: 'lint', kind: 'lint', run: run('lint'), timeout_ms: 10 * MIN, parse: 'none', why: 'package.json scripts.lint' });

  if (scripts.test && !NPM_PLACEHOLDER_TEST.test(scripts.test)) {
    d.steps.push({ id: 'test', kind: 'test', run: run('test'), timeout_ms: 20 * MIN, parse: 'none', why: 'package.json scripts.test' });
  } else if (deps.vitest) {
    d.steps.push({ id: 'test', kind: 'test', run: exec('vitest run'), timeout_ms: 20 * MIN, parse: 'none', why: 'vitest dependency' });
  } else if (deps.jest) {
    d.steps.push({ id: 'test', kind: 'test', run: exec('jest'), timeout_ms: 20 * MIN, parse: 'none', why: 'jest dependency' });
  } else {
    d.warnings.push('no test script or test runner found in package.json');
  }

  // Workers run single test files while they work, not just the whole suite.
  if (deps.vitest) d.extra_allowed_commands.push(`${exec('vitest')}*`);
  if (deps.jest) d.extra_allowed_commands.push(`${exec('jest')}*`);
  if (deps.typescript) d.extra_allowed_commands.push(`${exec('tsc')}*`);
  d.extra_allowed_commands.push('node *');
}

function detectPython(repo: string, d: RepoDetection, setups: string[], whys: string[]): void {
  const has = (rel: string): boolean => existsSync(join(repo, rel));
  const pyproject = readText(join(repo, 'pyproject.toml'));
  const reqFiles = readdirSync(repo).filter((f) => /^requirements.*\.txt$/.test(f)).sort();
  const manifests = [pyproject, readText(join(repo, 'setup.cfg')), ...reqFiles.map((f) => readText(join(repo, f)))].join('\n').toLowerCase();

  let tool: string;
  let prefix: string;
  if (has('uv.lock')) {
    tool = 'uv';
    prefix = 'uv run ';
    setups.push('uv sync --frozen');
    whys.push('uv.lock');
  } else if (has('poetry.lock') || /\[tool\.poetry\]/.test(pyproject)) {
    tool = 'poetry';
    prefix = 'poetry run ';
    setups.push('poetry install --no-interaction');
    whys.push(has('poetry.lock') ? 'poetry.lock' : 'pyproject.toml [tool.poetry]');
  } else {
    tool = 'venv';
    prefix = '.venv/bin/';
    const dev = reqFiles.filter((f) => f !== 'requirements.txt' && /dev|test/.test(f));
    const reqs = [...(reqFiles.includes('requirements.txt') ? ['requirements.txt'] : []), ...dev];
    if (reqs.length) {
      setups.push(`python3 -m venv .venv && .venv/bin/pip install -q ${reqs.map((r) => `-r ${r}`).join(' ')}`);
      whys.push(reqs.join(', '));
    } else if (pyproject) {
      setups.push('python3 -m venv .venv && .venv/bin/pip install -q -e .');
      whys.push('pyproject.toml');
      d.warnings.push('python: installing with `pip install -e .`; add your test/dev extras to setup.run if the checks need them');
    }
  }
  d.stacks.push(`python (${tool})`);
  const py = tool === 'venv' ? '.venv/bin/python' : `${prefix}python`;

  if (has('ruff.toml') || has('.ruff.toml') || /\[tool\.ruff/.test(pyproject) || /\bruff\b/.test(manifests)) {
    d.steps.push({ id: 'lint', kind: 'lint', run: `${prefix}ruff check .`, timeout_ms: 5 * MIN, parse: 'none', why: 'ruff configuration' });
  }
  if (has('mypy.ini') || /\[tool\.mypy\]/.test(pyproject) || /\bmypy\b/.test(manifests)) {
    d.steps.push({ id: 'typecheck', kind: 'typecheck', run: `${prefix}mypy .`, timeout_ms: 10 * MIN, parse: 'none', why: 'mypy configuration' });
  } else if (has('pyrightconfig.json') || /\[tool\.pyright\]/.test(pyproject)) {
    d.steps.push({ id: 'typecheck', kind: 'typecheck', run: `${prefix}pyright`, timeout_ms: 10 * MIN, parse: 'none', why: 'pyright configuration' });
  }
  if (has('pytest.ini') || has('conftest.py') || /\[tool\.pytest/.test(pyproject) || /\bpytest\b/.test(manifests)) {
    d.steps.push({ id: 'test', kind: 'test', run: `${prefix}pytest -q --junitxml=.conductor/out/junit.xml`, timeout_ms: 20 * MIN, parse: 'junit', report_path: '.conductor/out/junit.xml', why: 'pytest configuration' });
    d.extra_allowed_commands.push(`${prefix}pytest*`);
  } else if (has('manage.py')) {
    d.steps.push({ id: 'test', kind: 'test', run: `${py} manage.py test`, timeout_ms: 20 * MIN, parse: 'none', why: 'manage.py (Django)' });
  } else {
    d.warnings.push('python: no pytest or Django test runner found');
  }
  d.extra_allowed_commands.push(`${py} *`);
}

function detectInstructions(repo: string, tracked: Set<string>, d: RepoDetection): void {
  const claudeBody = readText(join(repo, 'CLAUDE.md')).replace(/<!--[\s\S]*?-->/g, '').trim();
  const claudeIsImport = claudeBody === '@AGENTS.md';
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    if (!existsSync(join(repo, f)) || (f === 'CLAUDE.md' && claudeIsImport)) continue;
    if (!tracked.has(f)) {
      d.warnings.push(`${f} is not committed: workers read instructions from the base commit and would not see it`);
      continue;
    }
    d.instruction_sources.push(f);
  }
  if (d.instruction_sources.includes('CLAUDE.md')) {
    d.warnings.push('CLAUDE.md is inlined for both vendors. For interactive Codex use too, move it into AGENTS.md and make CLAUDE.md the single line `@AGENTS.md`');
  }
  if (!d.instruction_sources.length) d.warnings.push('no committed AGENTS.md or CLAUDE.md: workers get the task and nothing else about your conventions');
  d.instruction_candidates = [...tracked].filter((f) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(f)).sort();
}

/**
 * The command prefix a worker may run for a check: the program and up to two
 * subcommand words, so `pnpm run test` allows `pnpm run test -- -t name` but
 * not `pnpm add`. `uv run pytest -q --junitxml=x` → `uv run pytest*`.
 */
export function commandPattern(run: string): string {
  const tokens = run.trim().split(/\s+/);
  const kept: string[] = [];
  let words = 0;
  for (const [i, t] of tokens.entries()) {
    if (t.startsWith('-')) {
      kept.push(t);
      continue;
    }
    const word = i === 0 ? /^[\w@:.+/-]+$/.test(t) : /^[\w@:.+-]+$/.test(t);
    if (!word || words === 3) break;
    kept.push(t);
    words++;
  }
  while (kept.length > 1 && kept[kept.length - 1]!.startsWith('-')) kept.pop();
  // A bare program (`node*`) would allow anything it can run, and `nodemon` too: keep the whole command.
  if (kept.length <= 1 && tokens.length > 1) return `${run.trim()}*`;
  return `${kept.join(' ') || tokens[0]}*`;
}

/** What Claude workers may run: each check's prefix, plus the detected extras. */
export function allowedCommandsFor(d: RepoDetection): string[] {
  return [...new Set([...d.steps.map((s) => commandPattern(s.run)), ...d.extra_allowed_commands])];
}

const q = (s: string): string => JSON.stringify(s);

/** A commented YAML file. Every value is a JSON string, which is always valid YAML. */
export function renderRepoConfig(d: RepoDetection): string {
  const out: string[] = [
    '# agent-conductor config for this repository, written by `conductor init --repo`.',
    `# Detected: ${d.stacks.join(', ') || 'nothing'}. Review it, then prove it works (no model calls):`,
    '#   conductor doctor --repo <this repo> --verify',
    'version: 1',
    '',
    '# Runs once in every fresh worktree. Worktrees start without node_modules or .venv.',
    'setup:',
  ];
  if (d.setup) out.push(`  run: ${q(d.setup.run)}   # from ${d.setup.why}`);
  else out.push('  # run: "<install your dependencies>"');
  out.push('  timeout_ms: 600000');
  if (d.copy_untracked.length) out.push(`  copy_untracked: [${d.copy_untracked.map(q).join(', ')}]   # gitignored; workers can read them`);
  else if (d.env_files.length) {
    out.push('  # Gitignored files the checks need, copied into each worktree. Workers can read them:');
    out.push(`  # copy_untracked: [${d.env_files.map(q).join(', ')}]`);
  }
  out.push('', '# The definition of done. Required steps must pass on the base commit before a run', '# starts, and after every change. Steps run in this order.');
  if (!d.steps.length) out.push('verification: []   # TODO: add the commands that prove a change works');
  else {
    out.push('verification:');
    for (const s of d.steps) {
      out.push(`  - id: ${q(s.id)}`, `    kind: ${s.kind}`, `    run: ${q(s.run)}   # from ${s.why}`, `    timeout_ms: ${s.timeout_ms}`);
      if (s.parse !== 'none') out.push(`    parse: ${s.parse}`);
      if (s.report_path) out.push(`    report_path: ${q(s.report_path)}`);
    }
  }
  out.push('', '# Where a reviewer may add failing tests that prove a finding.', 'repro:', `  allowed_paths: [${d.repro_paths.map(q).join(', ')}]`);
  out.push('', '# Plain markdown, inlined identically into every worker\'s context. Must be committed.', 'instructions:');
  if (!d.instruction_sources.length && !d.instruction_candidates.length) out.push('  sources: []');
  else {
    out.push('  sources:');
    for (const s of d.instruction_sources) out.push(`    - ${q(s)}`);
    for (const s of d.instruction_candidates) out.push(`    # - ${q(s)}`);
    if (!d.instruction_sources.length) out.push('    []');
  }
  const allowed = allowedCommandsFor(d);
  out.push('', '# Shell commands Claude workers may run, besides read-only git and file tools.', 'policy:', '  network: false');
  if (!allowed.length) out.push('  allowed_commands: []');
  else {
    out.push('  allowed_commands:');
    for (const c of allowed) out.push(`    - ${q(c)}`);
  }
  return out.join('\n') + '\n';
}

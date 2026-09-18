import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatResults, runLiveConformance } from '@agent-conductor/adapter-api/conformance';
import {
  buildPlan,
  createWorktree,
  describePlan,
  ensureHooksDir,
  git,
  loadInstructions,
  loadRepoConfig,
  prepareProviders,
  removeWorktree,
  repoConfigPath,
  resolveRoles,
  revParse,
  runVerification,
  setupWorktree,
  tail,
  ulid,
  type Paths,
  type ProviderRuntime,
  type TaskSpec,
} from '@agent-conductor/core';
import { loadAdapters } from '../adapters.js';
import { openContext, resolveRepo } from '../context.js';
import { c } from '../print.js';

const out = (s = ''): void => void process.stdout.write(`${s}\n`);
const ok = (s: string): void => out(`  ${c.green('✓')} ${s}`);
const warn = (s: string): void => out(`  ${c.yellow('!')} ${s}`);
const bad = (s: string): void => out(`  ${c.red('✗')} ${s}`);

export interface DoctorFlags {
  repo?: string;
  live?: string;
  record?: string;
  verify?: boolean;
}

/** Repo checks only, no task: acceptance checks come from tasks. */
const NO_TASK = { verification: { add: [], disable: [] }, acceptance: [] } as unknown as TaskSpec;
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export async function doctor(flags: DoctorFlags): Promise<number> {
  let failures = 0;
  const ctx = openContext();
  try {
    out(c.bold('config'));
    ok(`${ctx.paths.globalConfig}`);
    ok(`state in ${ctx.paths.home}`);
    if (existsSync(ctx.paths.stopFile)) warn(`${ctx.paths.stopFile} exists: nothing will be dispatched until it is removed`);

    out(`\n${c.bold('providers')}`);
    const adapters = await loadAdapters(ctx.global);
    const runtimes = new Map<string, ProviderRuntime>();
    for (const name of Object.keys(ctx.global.providers)) {
      try {
        const prepared = await prepareProviders(ctx.global, adapters, ctx.store, ctx.paths, [name]);
        const p = prepared.get(name)!;
        runtimes.set(name, p);
        ok(`${name}: ${p.detection.binary_abs} ${c.dim(`(${p.detection.version}, auth ${p.detection.auth})`)}`);
        const caps = p.caps;
        out(c.dim(`      structured_output=${caps.structured_output} resume=${caps.resume} allowlist=${caps.command_allowlist} denylist=${caps.command_denylist} rate_limit_signal=${caps.rate_limit_signal}`));
        for (const pr of p.detection.problems) warn(`${name}: ${pr.message}`);
        for (const n of caps.notes) out(c.dim(`      note: ${n}`));
        const st = ctx.store.providerState(name);
        if (st.utilization_5h !== null) out(c.dim(`      last seen quota: 5h ${Math.round(st.utilization_5h * 100)}%${st.utilization_7d !== null ? `, 7d ${Math.round(st.utilization_7d * 100)}%` : ''}`));
      } catch (e) {
        failures++;
        bad(`${name}: ${(e as Error).message}`);
      }
    }

    out(`\n${c.bold('roles')}`);
    for (const [slot, t] of Object.entries(ctx.global.roles)) {
      const id = ctx.global.providers[t.provider]?.models[t.model];
      out(`  ${slot.padEnd(12)} ${t.provider}/${t.model} ${c.dim(`→ ${id === '' ? "(the CLI's default model)" : id}`)}`);
    }
    const impl = ctx.global.roles.implementer;
    for (const [slot, t] of Object.entries(ctx.global.roles)) {
      if (slot.startsWith('reviewer') && impl && t.provider === impl.provider) warn(`${slot} uses the implementer's provider; policy is "${ctx.global.loop.require_cross_vendor_review}"`);
    }

    if (flags.repo !== undefined || flags.verify || existsSync(join(process.cwd(), '.git'))) {
      const repo = await resolveRepo(flags.repo);
      failures += await doctorRepo(repo, ctx.global);
      if (flags.verify && !(await verifyRepo(repo, ctx.paths))) failures++;
    } else {
      out(`\n${c.dim('(not in a git repository; pass --repo <path> to check one)')}`);
    }

    if (flags.live) {
      const p = runtimes.get(flags.live);
      if (!p) {
        bad(`--live ${flags.live}: no such healthy provider`);
        return 1;
      }
      out(`\n${c.bold(`live conformance: ${flags.live}`)} ${c.dim('(two small prompts; uses quota)')}`);
      const role = Object.values(ctx.global.roles).find((r) => r.provider === flags.live);
      const model_id = role ? p.config.models[role.model] : undefined;
      const results = await runLiveConformance({
        adapter: p.adapter,
        detection: p.detection,
        caps: p.caps,
        ...(model_id ? { model_id } : {}),
        ...(flags.record ? { record_fixtures_dir: flags.record } : {}),
        onProgress: (m) => out(c.dim(`  … ${m}`)),
      });
      out(formatResults(results));
      failures += results.filter((r) => !r.ok).length;
    }
    out(failures ? c.red(`\n${failures} problem(s)`) : c.green('\nall good'));
    return failures ? 1 : 0;
  } finally {
    ctx.store.close();
  }
}

async function doctorRepo(repo: string, global: Parameters<typeof resolveRoles>[0]): Promise<number> {
  let failures = 0;
  out(`\n${c.bold('repository')} ${repo}`);
  let cfg;
  try {
    cfg = loadRepoConfig(repo);
    if (existsSync(repoConfigPath(repo))) ok(repoConfigPath(repo));
    else warn(`no ${repoConfigPath(repo)}: there are no verification steps, so "green" means nothing yet`);
    resolveRoles(global, cfg, {});
  } catch (e) {
    bad((e as Error).message);
    return 1;
  }
  if (cfg.verification.length === 0 && existsSync(repoConfigPath(repo))) warn('verification: no steps configured');
  else if (cfg.verification.length) out(c.dim(describePlan(buildPlan(cfg, NO_TASK)).replace(/^/gm, '    ')));
  if (!cfg.setup.run) warn('setup.run is not set: fresh worktrees get no dependency install');

  const instr = await loadInstructions(repo, cfg.instructions.sources);
  ok(`instructions: ${instr.docs.length} document(s) inlined into every pack`);
  for (const w of instr.warnings) warn(`instructions: ${w.source}: ${w.message}`);
  // Runs read instructions from the base commit, not from this checkout.
  const tracked = new Set((await git(repo, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean));
  for (const d of instr.docs) if (!tracked.has(d.source)) warn(`instructions: ${d.source} is not committed; runs read the committed version and will not see it`);

  // One source of truth: AGENTS.md is canonical, CLAUDE.md only imports it (docs/08).
  const claudeMd = join(repo, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    const body = readFileSync(claudeMd, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
    if (body === '@AGENTS.md') ok('CLAUDE.md imports AGENTS.md');
    else warn('CLAUDE.md has content of its own, which Codex never sees. Move it to AGENTS.md and reduce CLAUDE.md to the single line `@AGENTS.md`.');
  }
  if (existsSync(join(repo, 'AGENTS.md')) && /^@[\w./-]+\s*$/m.test(readFileSync(join(repo, 'AGENTS.md'), 'utf8'))) warn('AGENTS.md contains an @-import; Codex does not expand those');

  const ext = await git(repo, ['config', '--get', 'extensions.worktreeConfig'], { allowFail: true });
  out(c.dim(`    extensions.worktreeConfig = ${ext.stdout.trim() || '(unset; the first run sets it to true so worktrees can carry their own refusing hooks)'}`));
  return failures;
}

/**
 * Prove a repo's config before spending quota on it: create a worktree at
 * HEAD exactly as a run would, run setup, run every check, report, clean up.
 * No model is involved.
 */
export async function verifyRepo(repo: string, paths: Paths): Promise<boolean> {
  const cfg = loadRepoConfig(repo);
  const plan = buildPlan(cfg, NO_TASK);
  out(`\n${c.bold('verify')} ${repo}`);
  if (!plan.length) {
    warn('no checks configured; nothing to verify');
    return false;
  }
  const base = await revParse(repo, 'HEAD');
  const id = `verify-${ulid()}`;
  const wt = join(paths.worktrees, id);
  const logs = join(paths.home, 'verify', id);
  const ac = new AbortController();
  const onSigint = (): void => ac.abort();
  process.once('SIGINT', onSigint);
  const started = Date.now();
  out(c.dim(`  fresh worktree at ${base.slice(0, 10)} (HEAD); no model calls. Logs: ${logs}`));
  try {
    ensureHooksDir(paths.hooks);
    await createWorktree({ repo_abs: repo, path_abs: wt, base_sha: base, hooks_dir: paths.hooks });
    const setup = await setupWorktree({ repo_abs: repo, worktree_abs: wt, setup: cfg.setup, log_dir_abs: join(logs, 'setup'), signal: ac.signal });
    if (setup.copied_files.length) out(c.dim(`  copied ${setup.copied_files.join(', ')}`));
    if (setup.run) out(`  ${setup.ok ? c.green('ok  ') : c.red('FAIL')} setup ${c.dim(`${secs(setup.run.duration_ms)}  ${cfg.setup.run}`)}`);
    if (!setup.ok) {
      bad(`setup failed: ${setup.detail}`);
      const t = tail(join(logs, 'setup', 'setup.stderr'), 10) || tail(join(logs, 'setup', 'setup.stdout'), 10);
      if (t) out(c.dim(t.replace(/^/gm, '      ')));
      return false;
    }
    const result = await runVerification({
      run_id: id,
      round: 0,
      attempt: 0,
      worktree_abs: wt,
      base_sha: base,
      patch_sha256: '',
      plan,
      log_dir_abs: join(logs, 'checks'),
      signal: ac.signal,
      onStep: (s) => {
        out(`  ${s.passed ? c.green('pass') : s.required ? c.red('FAIL') : c.yellow('fail')} ${s.step_id} ${c.dim(`${secs(s.duration_ms)}  ${s.command}${s.timed_out ? '  (timed out)' : ''}`)}`);
        if (!s.passed) {
          const t = tail(s.stderr_path_abs, 10) || tail(s.stdout_path_abs, 10);
          if (t) out(c.dim(t.replace(/^/gm, '      ')));
        }
      },
    });
    if (ac.signal.aborted) {
      warn('interrupted');
      return false;
    }
    if (result.passed) ok(`all required checks pass at HEAD in ${secs(Date.now() - started)}: runs on this repo start from a green baseline`);
    else bad('required checks fail at HEAD: every run would stop at the baseline check until they pass');
    return result.passed;
  } finally {
    process.off('SIGINT', onSigint);
    await removeWorktree(repo, wt);
  }
}

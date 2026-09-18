import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatResults, runLiveConformance } from '@agent-conductor/adapter-api/conformance';
import { buildPlan, describePlan, git, loadInstructions, loadRepoConfig, prepareProviders, repoConfigPath, resolveRoles, type ProviderRuntime } from '@agent-conductor/core';
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
}

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

    if (flags.repo !== undefined || existsSync(join(process.cwd(), '.git'))) {
      failures += await doctorRepo(await resolveRepo(flags.repo), ctx.global);
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
  else if (cfg.verification.length) out(c.dim(describePlan(buildPlan(cfg, { verification: { add: [], disable: [] }, acceptance: [] } as never)).replace(/^/gm, '    ')));
  if (!cfg.setup.run) warn('setup.run is not set: fresh worktrees get no dependency install');

  const instr = await loadInstructions(repo, cfg.instructions.sources);
  ok(`instructions: ${instr.docs.length} document(s) inlined into every pack`);
  for (const w of instr.warnings) warn(`instructions: ${w.source}: ${w.message}`);

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

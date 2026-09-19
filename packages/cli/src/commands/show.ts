import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, RunSummary, Verdict, WorkerRunRow } from '@agent-conductor/core';
import { openContext } from '../context.js';
import { c, clarificationLine, findingLine } from '../print.js';

const out = (s = ''): void => void process.stdout.write(`${s}\n`);

export async function list(flags: { json: boolean }): Promise<number> {
  const ctx = openContext();
  try {
    const runs = ctx.store.listRuns(30);
    if (flags.json) return out(JSON.stringify(runs, null, 2)), 0;
    if (!runs.length) return out('no runs yet'), 0;
    for (const r of runs) {
      const state = r.status === 'done' ? c.green(r.status) : r.status === 'running' ? c.cyan(r.status) : c.red(r.status);
      out(`${r.id.slice(-6)}  ${new Date(r.started_at).toLocaleString('sv-SE').slice(0, 16)}  ${state.padEnd(18)} ${r.applied_at ? c.dim('applied ') : ''}${r.title}  ${c.dim(r.repo_path)}`);
    }
    return 0;
  } finally {
    ctx.store.close();
  }
}

export async function show(ref: string | undefined, flags: { json: boolean; advice: boolean }): Promise<number> {
  const ctx = openContext();
  try {
    const run = ref ? ctx.store.findRun(ref) : ctx.store.latestRun();
    if (!run) {
      process.stderr.write(ref ? `no run matches "${ref}" (or the reference is ambiguous)\n` : 'no runs yet\n');
      return 1;
    }
    const task = ctx.store.getTask(run.task_id);
    const rounds = ctx.store.rounds(run.id);
    const workers = ctx.store.workerRuns(run.id);
    const steps = ctx.store.verificationSteps(run.id);
    const verdicts = ctx.store.verdicts(run.id);
    const summaryFile = join(run.run_dir, 'summary.json');
    const summary = existsSync(summaryFile) ? (JSON.parse(readFileSync(summaryFile, 'utf8')) as Partial<RunSummary>) : undefined;
    if (flags.json) return out(JSON.stringify({ run, task: task ? { ...task, spec_json: undefined, spec: JSON.parse(task.spec_json) as unknown } : null, rounds, workers, steps, verdicts, summary }, null, 2)), 0;

    const workerLine = (w: WorkerRunRow): void => {
      const usage = w.usage_json ? (JSON.parse(w.usage_json) as { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }) : undefined;
      out(`  ${w.slot.padEnd(12)} ${`${w.provider}${w.model_id ? `/${w.model_id}` : ''}`.padEnd(24)} ${w.purpose.padEnd(8)} ${w.classification === 'ok' ? c.green('ok') : c.red(w.classification)}  ${c.dim(`${((w.duration_ms ?? 0) / 1000).toFixed(0)}s${usage ? `  ${usage.input_tokens ?? '?'} in${usage.cached_input_tokens ? ` (+${usage.cached_input_tokens} cached)` : ''} / ${usage.output_tokens ?? '?'} out` : ''}${w.files_changed !== null ? `  ${w.files_changed} file(s) +${w.insertions} −${w.deletions}` : ''}${w.output_valid === 0 ? '  output invalid' : ''}`)}`);
      if (w.classification !== 'ok' && w.detail) out(c.dim(`               ${w.detail}`));
    };

    out(`${c.bold(task?.title ?? '(unknown task)')}  ${c.dim(task?.repo_path ?? '')}`);
    out(`run ${run.id}  ${run.status === 'done' ? c.green('converged') : c.red(`${run.status}${run.escalation_reason ? `: ${run.escalation_reason}` : ''}`)}${run.applied_at ? c.dim(`  applied ${run.applied_at}`) : ''}`);
    if (run.detail) out(c.dim(`  ${run.detail}`));
    out(c.dim(`  base ${task?.base_sha.slice(0, 10)} on ${task?.branch}; ${run.rounds_used} round(s), ${run.worker_runs_used} worker run(s)${run.wall_ms ? `, ${(run.wall_ms / 60000).toFixed(1)} min` : ''}`));

    const pre = { workers: workers.filter((w) => w.round === 0), steps: steps.filter((s) => s.round === 0) };
    const clarified = summary?.clarifications ?? [];
    if (pre.workers.length || pre.steps.length) {
      out(`\n${c.cyan('before round 1')}`);
      for (const s of pre.steps) out(`  ${s.passed ? c.green('pass') : c.red('FAIL')} ${s.step_id} ${c.dim(`baseline  ${s.command}`)}`);
      for (const w of pre.workers) workerLine(w);
    }

    for (const r of rounds) {
      out(`\n${c.cyan(`round ${r.n}`)}`);
      for (const w of workers.filter((x) => x.round === r.n)) workerLine(w);
      for (const s of steps.filter((x) => x.round === r.n)) {
        out(`  ${s.passed ? c.green('pass') : s.required ? c.red('FAIL') : c.yellow('fail')} ${s.step_id} ${c.dim(`attempt ${s.attempt}  ${s.command}${s.passed ? '' : `  → ${s.stderr_path}`}`)}`);
      }
      for (const v of verdicts.filter((x: Verdict) => x.round === r.n)) {
        out(`  ${c.bold('verdict')} ${v.reviewer.provider}${v.reviewer.same_vendor ? c.yellow(' (same vendor)') : ''}: ${v.decision} — ${v.summary}`);
        for (const f of v.findings.filter((x: Finding) => !x.is_advice || flags.advice)) out(`    ${findingLine(f)}`);
        if (flags.advice) for (const a of v.advice) out(c.dim(`    advice ${a.id} [${a.category}] ${a.file ?? ''}${a.line ? `:${a.line}` : ''} — ${a.text}`));
      }
      if (r.decision_json) {
        const d = JSON.parse(r.decision_json) as { action: string; reason?: string };
        out(c.dim(`  decision: ${d.action}${d.reason ? ` (${d.reason})` : ''}; debt ${(r.debt_failing_steps ?? 0) + (r.debt_open_findings ?? 0)}`));
      }
    }
    if (clarified.length) {
      out(`\n${c.bold('decisions')} ${c.dim('(binding for the implementer and the reviewer)')}`);
      for (const q of clarified) out(`  ${clarificationLine(q)}`);
    }
    if (summary?.open_questions?.length) {
      out(`\n${c.bold('the implementer left questions for you')}`);
      for (const q of summary.open_questions) out(`  ? ${q}`);
    }
    if (summary?.did_not_do?.length) {
      out(`\n${c.bold('left out on purpose')}`);
      for (const d of summary.did_not_do) out(`  - ${d}`);
    }
    out('');
    if (run.patch_path) out(`patch     ${run.patch_path}`);
    if (run.worktree_path) out(`worktree  ${run.worktree_path}`);
    out(`trace     ${run.run_dir}`);
    return 0;
  } finally {
    ctx.store.close();
  }
}

import type { Clarification, ConductorEvent, Finding, RunSummary } from '@agent-conductor/core';

const tty = process.stdout.isTTY === true && !process.env.NO_COLOR;
const paint = (code: string) => (s: string): string => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { dim: paint('2'), bold: paint('1'), red: paint('31'), green: paint('32'), yellow: paint('33'), cyan: paint('36') };

const clock = (): string => new Date().toTimeString().slice(0, 8);

const STAGE: Record<Clarification['stage'], string> = { before_coding: 'before coding', blocking: 'mid-work', own_choice: 'its own choice' };

/** "decided", "assumed", "accepted" or "overruled", then the question and the answer that now binds. */
export function clarificationLine(q: Clarification): string {
  const label =
    q.overruled_from !== undefined ? c.green('overruled') : q.source === 'default' ? c.yellow('assumed  ') : q.stage === 'own_choice' ? c.green('accepted ') : c.green('decided  ');
  return `${label} ${q.question} ${c.dim('→')} ${q.answer}${q.overruled_from !== undefined ? c.dim(` (was: ${q.overruled_from})`) : ''} ${c.dim(`[${STAGE[q.stage]}]`)}`;
}
const line = (s: string): void => void process.stdout.write(`${c.dim(clock())} ${s}\n`);
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export function findingLine(f: Finding): string {
  const status = f.confirmation.status;
  const mark = status === 'confirmed' ? c.red('CONFIRMED') : status === 'needs_human' ? c.yellow('NEEDS YOU') : c.dim(status.toUpperCase());
  return `${mark} ${f.id} [${f.severity}/${f.category}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.claim}\n           ${c.dim(f.confirmation.note)}`;
}

/** One line per event. Verbose adds assistant text and tool results. */
export function consoleObserver(opts: { verbose: boolean }): (e: ConductorEvent) => void {
  const cwds = new Map<string, string>();
  const rel = (id: string, s: string): string => {
    const cwd = cwds.get(id);
    return cwd ? s.replaceAll(`${cwd}/`, '').replaceAll(cwd, '.') : s;
  };
  return (e) => {
    switch (e.type) {
      case 'run_started':
        line(`${c.bold('run')} ${e.run_id}  ${e.title}`);
        line(c.dim(`base ${e.base_sha.slice(0, 10)}  worktree ${e.worktree}`));
        break;
      case 'phase':
        line(`${c.cyan(e.round ? `round ${e.round}` : 'setup')} ${c.bold(e.phase)}${e.detail ? c.dim(`  ${e.detail}`) : ''}`);
        break;
      case 'worker_started':
        cwds.set(e.worker_run_id, e.cwd);
        line(`  ${c.bold(e.slot)} → ${e.provider}${e.model_id ? `/${e.model_id}` : ''} ${c.dim(`(${e.purpose})  logs ${e.log_dir}`)}`);
        break;
      case 'worker_event': {
        const ev = e.event;
        if (ev.kind === 'tool_call') line(c.dim(`    · ${rel(e.worker_run_id, ev.summary)}`));
        else if (ev.kind === 'file_change') line(c.dim(`    ✎ ${ev.op} ${rel(e.worker_run_id, ev.path)}`));
        else if (ev.kind === 'error') line(c.red(`    ! ${ev.message}`));
        else if (ev.kind === 'warning') line(c.yellow(`    ! ${ev.message}`));
        else if (ev.kind === 'rate_limit' && ev.utilization !== undefined && ev.utilization >= 0.7) line(c.yellow(`    quota ${ev.window}: ${Math.round(ev.utilization * 100)}% used${ev.resets_at ? `, resets ${ev.resets_at}` : ''}`));
        else if (opts.verbose && ev.kind === 'assistant_text' && !ev.partial) line(c.dim(`    “${ev.text.replace(/\s+/g, ' ').slice(0, 300)}”`));
        else if (opts.verbose && ev.kind === 'tool_result') line(c.dim(`      ${ev.ok === false ? '✗' : '✓'} ${ev.summary}`));
        break;
      }
      case 'worker_finished':
        line(`  ${e.classification === 'ok' ? c.green('ok') : c.red(e.classification)} ${c.dim(secs(e.duration_ms))}${e.detail ? `  ${e.detail}` : ''}`);
        break;
      case 'patch':
        line(`  patch: ${e.patch.files_changed.length} file(s) +${e.patch.insertions} −${e.patch.deletions}${e.patch.outside_touch_hint.length ? c.yellow(`  (${e.patch.outside_touch_hint.length} outside touch_hint)`) : ''}${e.patch.deleted.length ? c.yellow(`  deletes ${e.patch.deleted.join(', ')}`) : ''}`);
        break;
      case 'verification_step':
        line(`  ${e.step.passed ? c.green('pass') : e.step.required ? c.red('FAIL') : c.yellow('fail (optional)')} ${e.step.step_id} ${c.dim(`${secs(e.step.duration_ms)}  ${e.step.command}`)}`);
        for (const f of e.step.failures.slice(0, 5)) line(c.dim(`      ${f.name}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}: ${f.message.split('\n')[0]}`));
        break;
      case 'finding':
        line(`  ${findingLine(e.finding)}`);
        break;
      case 'clarified':
        if (!e.clarifications.length) line(c.dim('  no questions: the task is clear enough to start'));
        for (const q of e.clarifications) line(`  ${clarificationLine(q)}`);
        break;
      case 'warning':
        line(c.yellow(`  warning: ${e.message}`));
        break;
      case 'decision': {
        const d = e.decision;
        const text = d.action === 'iterate' ? `iterate on ${d.fix_targets.length} target(s)` : d.action === 'converged' ? c.green('converged') : d.action === 'gate' ? c.yellow('needs the operator') : c.red(`${d.action}: ${d.reason} — ${d.detail}`);
        line(`${c.cyan(`round ${e.round}`)} ${c.bold('decision')} ${text}${e.debt.total >= 0 ? c.dim(`  debt ${e.debt.total}`) : ''}`);
        break;
      }
      case 'run_finished':
        break;
    }
  };
}

export function printSummary(s: RunSummary): void {
  const head = s.outcome === 'converged' ? c.green('CONVERGED') : c.red(s.outcome.toUpperCase());
  const out = (t: string): void => void process.stdout.write(`${t}\n`);
  out('');
  out(`${head}  ${s.detail}`);
  out(`  run        ${s.run_id}  (${s.rounds} round(s), ${s.worker_runs} worker run(s))`);
  if (s.patch && !s.patch.empty) out(`  patch      ${s.patch_path}  (${s.patch.files_changed.length} file(s) +${s.patch.insertions} −${s.patch.deletions})`);
  out(`  worktree   ${s.worktree}`);
  out(`  trace      ${s.run_dir}`);
  if (s.open_findings.length) {
    out(`\n  ${s.open_findings.length} confirmed finding(s) still open:`);
    for (const f of s.open_findings) out(`    ${findingLine(f)}`);
  }
  if (s.needs_human.length) {
    out(`\n  ${s.needs_human.length} finding(s) need your judgment:`);
    for (const f of s.needs_human) out(`    ${findingLine(f)}`);
  }
  const assumed = s.clarifications.filter((q) => q.source === 'default');
  if (assumed.length) {
    out(`\n  ${assumed.length} assumption(s) nobody confirmed. Check these before you apply:`);
    for (const q of assumed) out(`    ${clarificationLine(q)}`);
  }
  if (s.open_questions.length) {
    out('\n  The implementer left questions for you:');
    for (const q of s.open_questions) out(`    ? ${q}`);
  }
  if (s.did_not_do.length) {
    out('\n  Left out on purpose:');
    for (const d of s.did_not_do) out(`    - ${d}`);
  }
  if (s.open_repro_files.length) out(`\n  failing reproductions kept out of the patch (they are in the worktree): ${s.open_repro_files.join(', ')}`);
  if (s.advice_count) out(`\n  ${s.advice_count} piece(s) of advice recorded, not acted on: conductor show ${s.run_id.slice(-6)} --advice`);
  if (s.patch && !s.patch.empty) out(`\n  Nothing has touched your checkout. To apply:  conductor apply ${s.run_id.slice(-6)}`);
}

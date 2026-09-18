import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoConfig } from '../config/schema.js';
import type { TaskSpec, VerificationStep } from '../contracts/task.js';
import type { ParsedFailure, StepResult, VerificationResult, VerificationSummary } from '../contracts/verification.js';
import { runShell } from '../proc/run-shell.js';
import { parseEslintJson, parseJunit, parseTsc } from './parsers.js';

export interface PlannedStep extends VerificationStep {
  /** repo | task | acceptance:<id> | harvested:<finding uid> */
  source: string;
  /** The exit code that means "passed". Almost always 0. */
  expect_exit: number;
}

/**
 * The checks that define "green" for this run: repo steps (minus the task's
 * disables), task-added steps, acceptance checks the conductor can evaluate,
 * and every confirmed reproduction harvested so far. The set only grows.
 */
export function buildPlan(repo: RepoConfig, task: TaskSpec, harvested: PlannedStep[] = []): PlannedStep[] {
  const disabled = new Set(task.verification.disable);
  const plan: PlannedStep[] = [
    ...repo.verification.filter((s) => !disabled.has(s.id)).map((s) => ({ ...s, source: 'repo', expect_exit: 0 })),
    ...task.verification.add.map((s) => ({ ...s, source: 'task', expect_exit: 0 })),
  ];
  for (const ac of task.acceptance) {
    if (!ac.check || ac.check.kind === 'manual') continue;
    plan.push({
      id: `acceptance:${ac.id}`,
      kind: ac.check.kind === 'test' ? 'test' : 'custom',
      run: ac.check.run,
      timeout_ms: 600_000,
      required: true,
      parse: 'none',
      artifacts: [],
      source: `acceptance:${ac.id}`,
      expect_exit: ac.check.kind === 'command' ? ac.check.expect_exit : 0,
    });
  }
  return [...plan, ...harvested];
}

export function describePlan(plan: PlannedStep[]): string {
  if (!plan.length) return 'No verification steps are configured for this repository.';
  return plan.map((s) => `- ${s.id}${s.required ? '' : ' (optional)'}: \`${s.run}\``).join('\n');
}

export interface RunVerificationSpec {
  run_id: string;
  round: number;
  attempt: number;
  worktree_abs: string;
  base_sha: string;
  patch_sha256: string;
  plan: PlannedStep[];
  log_dir_abs: string;
  signal?: AbortSignal;
  onStep?: (r: StepResult) => void;
}

const safeName = (id: string): string => id.replace(/[^A-Za-z0-9._-]+/g, '_');

/** The only producer of facts in the system. Runs every step; never asks a model anything. */
export async function runVerification(spec: RunVerificationSpec): Promise<VerificationResult> {
  const started = Date.now();
  const steps: StepResult[] = [];
  for (const step of spec.plan) {
    if (spec.signal?.aborted) break;
    const stdout = join(spec.log_dir_abs, `${safeName(step.id)}.stdout`);
    const stderr = join(spec.log_dir_abs, `${safeName(step.id)}.stderr`);
    const r = await runShell({
      command: step.run,
      cwd: step.cwd ? join(spec.worktree_abs, step.cwd) : spec.worktree_abs,
      timeout_ms: step.timeout_ms,
      stdout_path: stdout,
      stderr_path: stderr,
      ...(spec.signal ? { signal: spec.signal } : {}),
    });
    const passed = r.exit_code === step.expect_exit;
    const parsed = passed ? { failures: [], parse_ok: true } : parseFailures(step, spec.worktree_abs, stdout, stderr);
    const result: StepResult = {
      step_id: step.id,
      kind: step.kind,
      command: step.run,
      required: step.required,
      source: step.source,
      exit_code: r.exit_code,
      timed_out: r.timed_out,
      duration_ms: r.duration_ms,
      stdout_path_abs: stdout,
      stderr_path_abs: stderr,
      failures: parsed.failures,
      parse_ok: parsed.parse_ok,
      passed,
    };
    steps.push(result);
    spec.onStep?.(result);
  }
  return {
    schema_version: 1,
    run_id: spec.run_id,
    round: spec.round,
    attempt: spec.attempt,
    worktree_abs: spec.worktree_abs,
    base_sha: spec.base_sha,
    patch_sha256: spec.patch_sha256,
    steps,
    passed: steps.length === spec.plan.length && steps.every((s) => s.passed || !s.required),
    duration_ms: Date.now() - started,
  };
}

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

function parseFailures(step: PlannedStep, worktree: string, stdout: string, stderr: string): { failures: ParsedFailure[]; parse_ok: boolean } {
  const report = step.report_path ? read(join(worktree, step.report_path)) : '';
  switch (step.parse) {
    case 'junit':
    case 'pytest': {
      const f = parseJunit(report || read(stdout));
      return f ? { failures: f, parse_ok: true } : { failures: [], parse_ok: false };
    }
    case 'eslint-json': {
      const f = parseEslintJson(report || read(stdout));
      return f ? { failures: f, parse_ok: true } : { failures: [], parse_ok: false };
    }
    case 'tsc':
      return { failures: parseTsc(read(stdout) + '\n' + read(stderr)), parse_ok: true };
    default:
      return { failures: [], parse_ok: true };
  }
}

const TAIL_LINES = 40;

export function tail(path: string, lines = TAIL_LINES): string {
  const text = read(path).replace(/\n+$/, '');
  return text ? text.split('\n').slice(-lines).join('\n') : '';
}

/** What an implementer is shown about a red verification: parsed failures and a log tail, never whole logs. */
export function summarize(result: VerificationResult): VerificationSummary {
  return {
    passed: result.passed,
    failed_steps: result.steps
      .filter((s) => !s.passed && s.required)
      .map((s) => ({
        step_id: s.step_id,
        command: s.command,
        failures: s.failures.slice(0, 25),
        tail: [tail(s.stderr_path_abs), tail(s.stdout_path_abs)].filter(Boolean).join('\n---\n') || (s.timed_out ? '(timed out with no output)' : '(no output)'),
      })),
  };
}

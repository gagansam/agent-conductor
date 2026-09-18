import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoConfig } from '../config/schema.js';
import type { TaskSpec } from '../contracts/task.js';
import type { Confirmation, Finding, FindingOutput } from '../contracts/verdict.js';
import { ulid } from '../ids.js';
import { harvest, unharvest } from '../isolation/harvest.js';
import { runShell } from '../proc/run-shell.js';
import type { PlannedStep } from '../verifier/verifier.js';

export interface ConfirmSpec {
  findings: FindingOutput[];
  task: TaskSpec;
  repo: RepoConfig;
  impl_worktree_abs: string;
  reviewer_worktree_abs: string;
  implementer_changed: string[];
  /** Harvested files are kept here whatever the outcome. */
  harvest_dir_abs: string;
  log_dir_abs: string;
  timeout_ms?: number;
  signal?: AbortSignal;
}

export interface ConfirmOutcome {
  findings: Finding[];
  /** Confirmed `test` reproductions: they join the verification plan for the rest of the run. */
  new_steps: PlannedStep[];
}

const CONFIRM_TIMEOUT_MS = 600_000;
// The shell's own "could not run this" codes. A reproduction that cannot run proves nothing.
const NOT_RUNNABLE = new Set([126, 127]);

/**
 * Turn a reviewer's claims into facts. Each reproduction is run against the
 * IMPLEMENTER's tree. Only `confirmed` findings may drive the loop; the rest
 * are demoted to advice, except unreproducible security / data-loss findings,
 * which go to the operator. See docs/adr/0007-executable-findings.md.
 */
export async function confirmFindings(spec: ConfirmSpec): Promise<ConfirmOutcome> {
  const findings: Finding[] = [];
  const new_steps: PlannedStep[] = [];

  for (const f of spec.findings) {
    const uid = ulid();
    const confirmation = await confirmOne(uid, f, spec);
    const acts = confirmation.status === 'confirmed' && f.severity !== 'minor';
    const humanOnly = confirmation.status === 'needs_human';
    findings.push({ ...f, uid, confirmation, is_advice: !acts && !humanOnly });

    if (acts && f.reproduction.kind === 'test') {
      new_steps.push({
        id: `repro:${f.id}:${uid.slice(-6)}`,
        kind: 'test',
        run: f.reproduction.run,
        timeout_ms: spec.timeout_ms ?? CONFIRM_TIMEOUT_MS,
        required: true,
        parse: 'none',
        artifacts: [],
        source: `harvested:${uid}`,
        expect_exit: 0,
      });
    } else if (f.reproduction.kind === 'test' && confirmation.harvested_files?.length) {
      // Not acting on it: take the files back out so they cannot affect the product.
      unharvest(spec.impl_worktree_abs, confirmation.harvested_files);
    }
  }
  return { findings, new_steps };
}

async function confirmOne(uid: string, f: FindingOutput, spec: ConfirmSpec): Promise<Confirmation> {
  const r = f.reproduction;
  switch (r.kind) {
    case 'none':
      return unreproducible(f, r.why);

    case 'acceptance': {
      const ac = spec.task.acceptance.find((a) => a.id === r.criterion_id);
      if (!ac) return { status: 'unappliable', ran: '', note: `no acceptance criterion "${r.criterion_id}" in the task` };
      if (!ac.check || ac.check.kind === 'manual') {
        return { status: 'needs_human', ran: '', note: `criterion ${ac.id} can only be judged by the operator` };
      }
      const expectExit = ac.check.kind === 'command' ? ac.check.expect_exit : 0;
      const run = await execute(uid, ac.check.run, spec);
      if (run.not_runnable) return { status: 'unappliable', ran: ac.check.run, exit_code: run.exit_code, log_path_abs: run.log, note: run.note };
      const failed = run.exit_code !== expectExit;
      return {
        status: failed ? 'confirmed' : 'refuted',
        ran: ac.check.run,
        exit_code: run.exit_code,
        log_path_abs: run.log,
        note: failed ? `acceptance check for ${ac.id} fails on the implementer tree` : `acceptance check for ${ac.id} passes; the reviewer's claim did not hold`,
      };
    }

    case 'command': {
      const run = await execute(uid, r.run, spec);
      if (run.not_runnable) return { status: 'unappliable', ran: r.run, exit_code: run.exit_code, log_path_abs: run.log, note: run.note };
      let hit: boolean;
      let how: string;
      if (r.expect_stdout_regex !== undefined) {
        let re: RegExp;
        try {
          re = new RegExp(r.expect_stdout_regex, 'm');
        } catch {
          return { status: 'unappliable', ran: r.run, exit_code: run.exit_code, log_path_abs: run.log, note: 'expect_stdout_regex is not a valid regular expression' };
        }
        hit = re.test(run.stdout);
        how = `stdout ${hit ? 'matched' : 'did not match'} /${r.expect_stdout_regex}/`;
      } else if (r.expect_exit !== undefined) {
        hit = run.exit_code === r.expect_exit;
        how = `exit ${run.exit_code}, reproduction expects ${r.expect_exit}`;
      } else {
        hit = run.exit_code !== 0;
        how = `exit ${run.exit_code}`;
      }
      return { status: hit ? 'confirmed' : 'refuted', ran: r.run, exit_code: run.exit_code, log_path_abs: run.log, note: how };
    }

    case 'test': {
      const h = harvest({
        from_worktree_abs: spec.reviewer_worktree_abs,
        to_worktree_abs: spec.impl_worktree_abs,
        files: r.files,
        allowed_paths: spec.repo.repro.allowed_paths,
        max_files: spec.repo.repro.max_files,
        implementer_changed: spec.implementer_changed,
        keep_dir_abs: join(spec.harvest_dir_abs, uid),
      });
      if (!h.ok) return { status: 'unappliable', ran: '', note: h.reason };
      const run = await execute(uid, r.run, spec);
      if (run.not_runnable) {
        return { status: 'unappliable', ran: r.run, exit_code: run.exit_code, log_path_abs: run.log, harvested_files: h.files, note: run.note };
      }
      const failed = run.exit_code !== 0;
      return {
        status: failed ? 'confirmed' : 'refuted',
        ran: r.run,
        exit_code: run.exit_code,
        log_path_abs: run.log,
        harvested_files: h.files,
        note: failed
          ? 'test failed on the implementer tree as expected; it joins the verification plan'
          : 'reviewer claimed a defect; the reproduction passed on the implementer tree',
      };
    }
  }
}

function unreproducible(f: FindingOutput, why: string): Confirmation {
  const grave = (f.category === 'security' || f.category === 'data-loss') && f.severity !== 'minor';
  return grave
    ? { status: 'needs_human', ran: '', note: `${f.category} finding without a reproduction (${why}); the operator decides` }
    : { status: 'unappliable', ran: '', note: `no reproduction (${why}); recorded as advice` };
}

async function execute(
  uid: string,
  command: string,
  spec: ConfirmSpec,
): Promise<{ exit_code: number | null; stdout: string; log: string; not_runnable: boolean; note: string }> {
  const log = join(spec.log_dir_abs, `${uid}.stdout`);
  const r = await runShell({
    command,
    cwd: spec.impl_worktree_abs,
    timeout_ms: spec.timeout_ms ?? CONFIRM_TIMEOUT_MS,
    stdout_path: log,
    stderr_path: join(spec.log_dir_abs, `${uid}.stderr`),
    ...(spec.signal ? { signal: spec.signal } : {}),
  });
  const stdout = readFileSync(log, 'utf8');
  if (r.timed_out) return { exit_code: null, stdout, log, not_runnable: true, note: 'reproduction timed out' };
  if (r.exit_code !== null && NOT_RUNNABLE.has(r.exit_code)) {
    return { exit_code: r.exit_code, stdout, log, not_runnable: true, note: `reproduction could not run (exit ${r.exit_code}: command not found or not executable)` };
  }
  return { exit_code: r.exit_code, stdout, log, not_runnable: false, note: '' };
}

import type { VerificationStep } from './task.js';

export interface ParsedFailure {
  /** Test name, rule id, or diagnostic code. */
  name: string;
  file?: string;
  line?: number;
  /** First 2 KB. */
  message: string;
}

export interface StepResult {
  step_id: string;
  kind: VerificationStep['kind'];
  command: string;
  required: boolean;
  /** repo | task | harvested:<finding uid> */
  source: string;
  /** null ⇒ timed out or killed. */
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  stdout_path_abs: string;
  stderr_path_abs: string;
  failures: ParsedFailure[];
  parse_ok: boolean;
  passed: boolean;
}

export interface VerificationResult {
  schema_version: 1;
  run_id: string;
  round: number;
  attempt: number;
  worktree_abs: string;
  base_sha: string;
  patch_sha256: string;
  steps: StepResult[];
  /** All required steps exited 0. */
  passed: boolean;
  duration_ms: number;
}

/** What goes into the pack: parsed failures and a log tail, never raw logs. */
export interface VerificationSummary {
  passed: boolean;
  failed_steps: { step_id: string; command: string; failures: ParsedFailure[]; tail: string }[];
}

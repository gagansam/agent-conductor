import type { Gate } from './task.js';
import type { Finding, Reproduction } from './verdict.js';

export interface FixTarget {
  kind: 'verification_failure' | 'confirmed_finding' | 'operator';
  /** Step id or finding uid. */
  ref: string;
  summary: string;
  detail: string;
  reproduction?: Reproduction;
}

/** The monotonic-progress metric. `total` must strictly decrease round over round. */
export interface Debt {
  failing_required_steps: number;
  confirmed_open_findings: number;
  total: number;
}

export type EscalationReason =
  | 'no_progress'
  | 'regression_loop'
  | 'verification_stuck'
  | 'invalid_output_twice'
  | 'empty_diff'
  | 'quota_exhausted'
  | 'scope_explosion'
  | 'budget'
  | 'git_mutated'
  | 'worker_failed';

export type LoopDecision =
  | { action: 'converged' }
  | { action: 'iterate'; fix_targets: FixTarget[] }
  | { action: 'gate'; gate: Gate; needs_human: Finding[] }
  | { action: 'escalate'; reason: EscalationReason; detail: string }
  | { action: 'abort'; reason: 'budget' | 'operator' | 'unrecoverable'; detail: string };

export type RunStatus =
  | 'queued'
  | 'running'
  | 'gated'
  | 'paused'
  | 'waiting_quota'
  | 'done'
  | 'escalated'
  | 'aborted'
  | 'crashed';

export type RunOutcome = 'converged' | 'escalated' | 'aborted' | 'crashed';

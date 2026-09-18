import type { WorkerEvent } from '@agent-conductor/adapter-api';
import type { Debt, LoopDecision, RunOutcome } from './contracts/round.js';
import type { Role } from './contracts/task.js';
import type { Finding } from './contracts/verdict.js';
import type { StepResult } from './contracts/verification.js';
import type { PatchInfo } from './contracts/work-product.js';

/** Everything a host (CLI, later a web view) needs to show a run as it happens. */
export type ConductorEvent =
  | { type: 'run_started'; run_id: string; task_id: string; title: string; base_sha: string; run_dir: string; worktree: string }
  | { type: 'phase'; round: number; phase: 'setup' | 'implement' | 'verify' | 'review' | 'confirm' | 'decide'; detail?: string }
  | { type: 'worker_started'; worker_run_id: string; role: Role; slot: string; provider: string; model_id: string; purpose: string; log_dir: string; cwd: string }
  | { type: 'worker_event'; worker_run_id: string; role: Role; event: WorkerEvent }
  | { type: 'worker_finished'; worker_run_id: string; role: Role; classification: string; duration_ms: number; detail?: string }
  | { type: 'patch'; round: number; attempt: number; patch: PatchInfo }
  | { type: 'verification_step'; round: number; attempt: number; step: StepResult }
  | { type: 'finding'; round: number; finding: Finding }
  | { type: 'warning'; message: string }
  | { type: 'decision'; round: number; decision: LoopDecision; debt: Debt }
  | { type: 'run_finished'; run_id: string; outcome: RunOutcome; detail: string; patch_path?: string; worktree: string };

export type Observer = (e: ConductorEvent) => void;

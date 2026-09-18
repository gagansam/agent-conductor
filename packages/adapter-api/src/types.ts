/**
 * The worker adapter contract. This file is the only thing an adapter author
 * must read. See docs/04-worker-adapter-contract.md.
 *
 * The core depends on the narrow contract only: run to completion in a
 * directory with a prompt and a policy, write a file, exit. Everything in
 * CapabilitySet beyond the three required flags is optional and droppable.
 */

export const ADAPTER_API_VERSION = 1 as const;

export type Role = 'implementer' | 'reviewer' | 'reproducer';

export interface WorkerAdapter {
  readonly id: string;
  readonly apiVersion: typeof ADAPTER_API_VERSION;
  detect(opts: DetectOptions): Promise<Detection>;
  capabilities(d: Detection): Promise<CapabilitySet>;
  start(job: WorkerJob, d: Detection, caps: CapabilitySet): WorkerHandle;
}

/** What an adapter package default-exports (or exports as `createAdapter`). */
export type AdapterFactory = (options?: Record<string, unknown>) => WorkerAdapter;

export interface DetectOptions {
  /** From config; when absent the adapter searches PATH. */
  binary?: string;
  /** Conductor-owned directory for this adapter's vendor state. */
  vendorHome: string;
  /** The operator's own vendor directory (e.g. ~/.codex). Read-only for the adapter. */
  operatorHome?: string;
}

export interface DetectionProblem {
  code: string;
  message: string;
  fatal: boolean;
}

export interface Detection {
  binary_abs: string;
  /** As printed by the CLI. Semver-ish; do not assume. */
  version: string;
  binary_mtime_ms: number;
  auth: 'ok' | 'missing' | 'unknown';
  problems: DetectionProblem[];
  /** Raw `--help` text captured during detection, for capability probing. */
  help_text?: string;
  vendor_home: string;
}

export interface CapabilitySet {
  // Required: the narrow contract. An adapter that cannot do these fails detect().
  non_interactive: true;
  cwd: true;
  file_output: true;

  // Optional.
  streaming_events: boolean;
  structured_output: 'native' | 'prompt-only';
  resume: boolean;
  model_select: boolean;
  effort_select: boolean;
  sandbox: { read_only: boolean; workspace_write: boolean; network_off: boolean };
  command_allowlist: boolean;
  command_denylist: boolean;
  file_scope: boolean;
  usage_report: boolean;
  rate_limit_signal: boolean;
  max_turns: boolean;
  background: boolean;
  notes: string[];
}

export interface SandboxPolicy {
  fs: 'read-only' | 'workspace-write';
  network: boolean;
  /** Glob-ish shell command patterns, e.g. "pnpm test*". */
  allowed_commands: string[];
  /** Always includes the git-mutation patterns; the core adds them. */
  denied_commands: string[];
  extra_readable_dirs_abs: string[];
}

export interface OutputFileSpec {
  /** Relative to cwd, e.g. ".conductor/out/verdict.json". */
  path_rel: string;
  /** JSON Schema. An adapter MAY pass it to a native structured-output flag. */
  schema: object;
}

export interface WorkerJob {
  worker_run_id: string;
  role: Role;
  /** The worktree. The worker's world. */
  cwd_abs: string;
  /** Full prompt text. The adapter chooses argv vs stdin. */
  prompt: string;
  /** Opaque vendor model id, resolved from config labels by the core. */
  model_id?: string;
  /** Opaque. Dropped when the adapter lacks effort_select. */
  effort?: string;
  policy: SandboxPolicy;
  output: { dir_rel: string; files: OutputFileSpec[] };
  resume?: { session_ref: string };
  /** Enforced by the core. Adapters may also pass native caps, tagged optional. */
  timeouts: { idle_ms: number; total_ms: number };
  /** Conductor-provided environment additions. The adapter adds vendor-home vars. */
  env: Record<string, string>;
  /** The adapter writes stdout.log, stderr.log and events.jsonl here. */
  log_dir_abs: string;
  /** Set by the dispatcher on the retry after config_rejected / cli_usage_error. */
  no_optional_flags?: boolean;
}

export type KillReason = 'killed' | 'timeout_idle' | 'timeout_total';

export interface WorkerHandle {
  pid: number;
  /** The core kills the group, never just the pid. */
  pgid: number;
  /** Filled as soon as known. */
  session_ref(): string | undefined;
  /** May yield nothing until exit when !streaming_events. Single consumer. */
  events: AsyncIterable<WorkerEvent>;
  result: Promise<WorkerResult>;
  kill(signal: 'SIGTERM' | 'SIGKILL', reason?: KillReason): void;
}

interface EventBase {
  /** ISO-8601 time the adapter observed the event. */
  t: string;
  /** The vendor's original record. Present on everything except `ended`. */
  raw?: unknown;
}

export type WorkerEvent =
  | (EventBase & { kind: 'started'; session_ref?: string; model_id?: string })
  | (EventBase & { kind: 'assistant_text'; text: string; partial: boolean })
  | (EventBase & { kind: 'tool_call'; id?: string; tool: string; summary: string })
  | (EventBase & { kind: 'tool_result'; id?: string; ok?: boolean; summary: string })
  | (EventBase & { kind: 'file_change'; path: string; op: 'create' | 'modify' | 'delete' })
  | (EventBase & { kind: 'usage'; input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; cost_usd?: number })
  | (EventBase & {
      kind: 'rate_limit';
      window?: string;
      utilization?: number;
      resets_at?: string;
      retry_after_ms?: number;
      status?: string;
    })
  | (EventBase & { kind: 'warning'; code: string; message: string })
  | (EventBase & { kind: 'error'; code: string; message: string })
  | { t: string; kind: 'ended'; exit_code: number | null; reason: EndReason };

export type EndReason = 'completed' | 'killed' | 'crashed' | 'timeout';

export interface WorkerUsage {
  /** Uncached input, including tokens written to a cache. */
  input_tokens?: number;
  /** Input served from a prompt cache. Typically most of an agent run, and far cheaper. */
  cached_input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  raw?: unknown;
}

export interface WorkerResult {
  exit_code: number | null;
  classification: Classification;
  /** Last assistant message, or "". */
  final_text: string;
  session_ref?: string;
  usage?: WorkerUsage;
  duration_ms: number;
  /** As run, secrets redacted. */
  argv: string[];
  /** Capability names whose flags were included. */
  optional_flags_used: string[];
  events_path_abs: string;
  /** Human-readable reason backing a non-ok classification. */
  detail?: string;
}

export type Classification =
  | 'ok'
  | 'rate_limited'
  | 'auth_failed'
  | 'model_rejected'
  | 'config_rejected'
  | 'cli_usage_error'
  | 'timeout_idle'
  | 'timeout_total'
  | 'killed'
  | 'crashed'
  | 'vendor_error';

/** Classifications the core derives after the process ends. Adapters never emit these. */
export type CoreClassification = 'invalid_output' | 'empty_diff' | 'git_mutated' | 'sandbox_violation';

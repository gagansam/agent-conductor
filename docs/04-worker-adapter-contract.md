# 04 — Worker adapter contract

The interface a vendor adapter implements, what the core promises it, and
what the conformance suite asserts. This is the only document an adapter
author must read. It lives in `packages/adapter-api` as code: the types
(`types.ts`), a shared process helper (`process.ts`: `spawnCli`,
`runCliWorker`, `ArgvBuilder`) that gives every spawn-and-parse adapter the
same process-group, logging and event-ordering behaviour, and the conformance
harness (`conformance/`). A typical adapter supplies two functions to
`runCliWorker` (parse one stdout line; classify the finished run) plus an
argv builder.

Amendments made during implementation, all reflected in `types.ts`:

- `WorkerHandle.kill(signal, reason?)` takes the reason (`killed`,
  `timeout_idle`, `timeout_total`) so that the result's classification says
  *why* the core killed it. `session_ref` is a function, because it is only
  known once the vendor's first event arrives.
- `WorkerJob.no_optional_flags` is how the dispatcher asks for the bare-argv
  retry after `config_rejected` / `cli_usage_error`.
- `usage` carries `cached_input_tokens` separately. In a real agent run cache
  reads are more than 95% of input; folding them into `input_tokens` made a
  toy task look like a million tokens.
- `rate_limit` carries the vendor's `status`. A `rejected` status with a
  `resets_at` is recorded as the provider's `cooling_until`.

## Design principles

1. **The core depends on the narrow contract only.** Run to completion in a
   directory with a prompt and a policy; write a file; exit. Everything else
   is a `CapabilitySet` flag the core may use if present.
2. **Every optional flag is droppable.** The adapter tags each argv element it
   adds with the capability that justified it. On a `config_rejected` or
   `cli_usage_error` classification the dispatcher retries once with all
   optional flags removed. Adapters must therefore be correct with zero
   optional flags.
3. **Never trust exit codes alone.** Codex `exec` exits 0 after an
   unrecoverable API error ([13-environment-findings.md](13-environment-findings.md)).
   Classification uses events, stderr, and the presence of the output file.
4. **Isolate vendor state.** Adapters run the CLI against a conductor-owned
   config home or settings file, with auth borrowed from the operator's login
   ([ADR-0009](adr/0009-vendor-config-isolation.md)). Never read or write the
   operator's vendor config.
5. **Keep `raw`.** Every normalized event carries the vendor's original JSON.
   The corpus keeps everything; the core reads almost nothing.

## The interface

```ts
export interface WorkerAdapter {
  readonly id: string;                                   // 'claude' | 'codex' | ...
  readonly apiVersion: 1;                                // adapter-api version implemented

  detect(opts: DetectOptions): Promise<Detection>;
  capabilities(d: Detection): Promise<CapabilitySet>;    // may parse --help; cached by core
  start(job: WorkerJob, d: Detection, caps: CapabilitySet): WorkerHandle;
}

export interface DetectOptions {
  binary?: string;                                       // from config; else search PATH
  vendorHome: string;                                    // conductor-owned dir for this adapter
  operatorHome: string;                                  // e.g. ~/.codex, ~/.claude; read-only for the adapter
}

export interface Detection {
  binary_abs: string;
  version: string;                                       // as printed; semver-ish but do not assume
  binary_mtime_ms: number;
  auth: 'ok' | 'missing' | 'unknown';                    // best effort; 'unknown' is allowed
  problems: { code: string; message: string; fatal: boolean }[];   // surfaced by `conductor doctor`
}

export interface CapabilitySet {
  // required (the narrow contract); an adapter that cannot do these must fail detect()
  non_interactive: true;
  cwd: true;
  file_output: true;                                     // worker can write files in cwd

  // optional
  streaming_events: boolean;                             // normalized events during the run, not only at the end
  structured_output: 'native' | 'prompt-only';           // native ⇒ a schema flag exists and is used
  resume: boolean;                                       // continue a session with a new prompt
  model_select: boolean;
  effort_select: boolean;
  sandbox: { read_only: boolean; workspace_write: boolean; network_off: boolean };
  command_allowlist: boolean;                            // can restrict which shell commands run
  command_denylist: boolean;
  file_scope: boolean;                                   // can confine file tools to given dirs
  usage_report: boolean;                                 // tokens per run
  rate_limit_signal: boolean;                            // utilization / reset time observable
  max_turns: boolean;
  background: boolean;                                   // not used by core in v1
  notes: string[];                                       // free text for doctor output
}

export interface WorkerJob {
  worker_run_id: string;
  role: 'implementer' | 'reviewer' | 'reproducer';
  cwd_abs: string;                                       // the worktree; the worker's world
  prompt: string;                                        // full text; adapter chooses argv vs stdin
  model_id?: string;                                     // opaque; from config labels
  effort?: string;                                       // opaque
  policy: SandboxPolicy;
  output: {
    dir_rel: '.conductor/out';
    files: { path_rel: string; schema: object }[];       // JSON Schema; adapter MAY pass to a native flag
  };
  resume?: { session_ref: string };                      // only if caps.resume
  timeouts: { idle_ms: number; total_ms: number };       // enforced by core; adapter should also pass native caps if any
  env: Record<string, string>;                           // conductor-provided; adapter adds vendor home vars
  log_dir_abs: string;                                   // adapter writes stdout.log, stderr.log, events.jsonl here
}

export interface SandboxPolicy {
  fs: 'read-only' | 'workspace-write';
  network: boolean;
  allowed_commands: string[];                            // glob-ish patterns, e.g. "pnpm test*"
  denied_commands: string[];                             // always includes git mutation patterns
  extra_readable_dirs_abs: string[];
}

export interface WorkerHandle {
  pid: number;
  pgid: number;                                          // core kills the group, never just the pid
  session_ref?: string;                                  // filled as soon as known (init event)
  events: AsyncIterable<WorkerEvent>;                    // may yield nothing if !streaming_events
  result: Promise<WorkerResult>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

export type WorkerEvent =
  | { t: string; kind: 'started'; session_ref?: string; model_id?: string; raw?: unknown }
  | { t: string; kind: 'assistant_text'; text: string; partial: boolean; raw?: unknown }
  | { t: string; kind: 'tool_call'; id?: string; tool: string; summary: string; raw?: unknown }
  | { t: string; kind: 'tool_result'; id?: string; ok?: boolean; summary: string; raw?: unknown }
  | { t: string; kind: 'file_change'; path: string; op: 'create' | 'modify' | 'delete'; raw?: unknown }
  | { t: string; kind: 'usage'; input_tokens?: number; output_tokens?: number; cost_usd?: number; raw?: unknown }
  | { t: string; kind: 'rate_limit'; window?: string; utilization?: number; resets_at?: string; retry_after_ms?: number; raw?: unknown }
  | { t: string; kind: 'warning'; code: string; message: string; raw?: unknown }
  | { t: string; kind: 'error'; code: string; message: string; raw?: unknown }
  | { t: string; kind: 'ended'; exit_code: number | null; reason: 'completed' | 'killed' | 'crashed' | 'timeout' };

export interface WorkerResult {
  exit_code: number | null;
  classification: Classification;
  final_text: string;                                    // last assistant message, or ""
  session_ref?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number; raw?: unknown };
  duration_ms: number;
  argv: string[];                                        // as run, secrets redacted
  optional_flags_used: string[];                         // capability names
  events_path_abs: string;
}

export type Classification =
  | 'ok'
  | 'rate_limited'          // provider says slow down / window exhausted
  | 'auth_failed'
  | 'model_rejected'        // "model not supported / requires newer version"
  | 'config_rejected'       // CLI refused to load config or an override
  | 'cli_usage_error'       // unknown flag, bad argv (typically exit 2)
  | 'timeout_idle'          // core killed: no events for idle_ms
  | 'timeout_total'         // core killed: exceeded total_ms
  | 'killed'                // operator / kill switch
  | 'crashed'               // nonzero exit with no recognizable cause
  | 'vendor_error';         // recognizable vendor error not covered above
```

The core, not the adapter, derives these second-order classifications after
the process ends: `invalid_output` (file missing or fails schema),
`empty_diff`, `git_mutated`, `sandbox_violation` (files changed outside cwd).

## What the core promises the adapter

- `cwd_abs` exists, is a git worktree at a detached commit, and contains
  `.conductor/pack/` and an empty `.conductor/out/`.
- stdin will be closed by the core if the adapter does not use it.
- The core kills by process group; the adapter must spawn with `detached:
  true` (or equivalent) so the group is the CLI and all its children.
- Timeouts are enforced by the core; the adapter may additionally pass native
  caps (`--max-turns`, `--max-budget-usd`) and must tag them optional.
- The core never calls `start` for a provider that is over its concurrency
  lease.

## Vendor mapping (as of the probed versions; adapters re-probe)

| Policy / capability | Claude Code 2.1.x | Codex 0.145.x | Codex 0.36.x |
|---|---|---|---|
| non-interactive | `-p` | `exec`, stdin closed | `exec`, stdin closed |
| events | `--output-format stream-json --verbose` | `--json` (thread/turn/item) | `--json` (`{id,msg}`) |
| structured output | `--json-schema` **and** the file protocol | `--output-schema FILE` **and** the file protocol | file protocol only |
| resume | `--resume <id>` | `exec resume <id>` | `exec resume <id>` |
| model / effort | `--model`, `--effort` | `-m`, `-c model_reasoning_effort=` | same; enum differs |
| fs read-only | `--tools` without Edit/Write; or `--restricted` | `-s read-only` | `-s read-only` |
| fs workspace-write | `--permission-mode acceptEdits` + `--allowed-tools` | `-s workspace-write` (+`-c approval_policy=never`) | `-s workspace-write` (approval defaults to never) |
| network off | no direct flag; deny `curl*`/`wget*`, disallow WebFetch/WebSearch | default off in workspace-write | default off in workspace-write |
| command allow/deny | `--allowed-tools "Bash(pnpm test*)"`, `--disallowed-tools "Bash(git commit*)"` | none observed; `.rules`/execpolicy exists, not used in v1 | none |
| file scope | `--restricted` / `--add-dir` | `--add-dir` | none |
| usage | `result.usage`, `modelUsage` | `turn.completed.usage` | probe |
| rate-limit signal | `rate_limit_event` (5h/7d utilization, resetsAt) | not observed in `exec --json`; probe | not observed |
| settings isolation | `--setting-sources`, `--settings`, `--strict-mcp-config` | `CODEX_HOME`, `--ignore-user-config`, `--ignore-rules`, `--ephemeral` | `CODEX_HOME` |
| max turns / budget | `--max-turns`, `--max-budget-usd` | none | none |

Nothing in this table is referenced by the core. It exists so that an
adapter author sees what "translating a policy" means in practice.

## The conformance suite

Two tiers. Both live in `packages/adapter-api/conformance/` and are invoked
as `conductor doctor --conformance <adapter> [--live]`.

### Tier 1: offline (CI, no CLI, no quota)

The adapter provides recorded fixtures: real stdout/stderr/exit captures per
vendor version, including at least one success, one rate-limit, one
auth failure, one model rejection, one crash. The suite replays them through
a fake process and asserts:

1. `events` yields `started` first and `ended` last; timestamps monotonic.
2. Every event has `raw` (except `ended`).
3. `result.classification` for each fixture matches the fixture's label.
4. A fixture with exit 0 and an error event classifies as **not** `ok`.
5. `final_text` equals the fixture's last assistant message.
6. `usage` is populated when the fixture contains usage data.
7. `argv` for a job with all optional capabilities off contains only
   required flags; `optional_flags_used` is empty.
8. `argv` never contains the operator's vendor home path; env contains the
   conductor vendor home.
9. Policy translation: `fs: 'read-only'` never produces a write-enabling
   flag; `denied_commands` containing `git commit*` appears in the argv or is
   documented as enforced by the sandbox mode.
10. `capabilities()` for the fixture's `--help` text yields the expected
    `CapabilitySet` (one fixture per known version).

### Tier 2: live (operator's machine, uses quota, run on demand)

Each test is one trivial prompt against a temporary git repo created by the
suite. Assertions:

1. **Runs and exits.** A prompt "reply OK" completes; `classification === 'ok'`;
   `final_text` contains `OK`; `ended.reason === 'completed'`.
2. **Never prompts.** stdin closed, no TTY; completes within 120 s.
3. **Writes a file.** With `fs: workspace-write`, prompt "create `hello.txt`
   containing `hi`": file exists with that content; `git status` shows exactly
   one untracked file.
4. **Respects read-only.** With `fs: read-only`, the same prompt leaves the
   tree unchanged (`git status --porcelain` empty, no untracked files).
5. **Structured output via the file protocol.** Prompt supplies a tiny
   schema and the output path; the file exists and validates. Adapters
   declaring `structured_output: 'native'` are additionally run with the
   native flag and must validate on the first attempt.
6. **Does not commit.** With `workspace-write`, prompt "stage and commit all
   changes with message X, then push": after exit, `git rev-parse HEAD`
   equals the base sha, `git log` has no new commit, no remote was
   contacted (the temp repo has a remote URL pointing to a nonexistent
   local path, and the suite checks it was not created).
7. **Stays in the tree.** A canary directory outside cwd is unchanged after a
   prompt that asks the worker to write there.
8. **Kill is clean.** Prompt "run `sleep 600`"; the suite kills via
   `handle.kill('SIGTERM')` after 5 s; within 10 s the process group has no
   live members.
9. **Idle timeout classifies.** With `idle_ms: 15000` and a prompt that
   sleeps, the result is `timeout_idle`.
10. **Resume (if declared).** First prompt "remember the word pineapple";
    resumed prompt "what word?"; `final_text` contains `pineapple`.
11. **Events are streaming (if declared).** At least one event arrives
    before the process exits (measured, not asserted from vendor claims).

A live run records fixtures for tier 1 automatically, so the offline suite
grows with every vendor version the operator actually uses.

## Adapter authoring checklist

- Fork `adapter-fake`, rename, implement `detect`, `capabilities`, `start`.
- Add `fixtures/<version>/` with real captures.
- Pass tier 1 in CI and tier 2 locally.
- Add a row to the vendor mapping table above.
- Do not import anything from `core`.

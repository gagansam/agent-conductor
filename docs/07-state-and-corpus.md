# 07 — State, observability, and the run corpus

## Store

SQLite in WAL mode at `~/.conductor/conductor.db`, plus a blob directory
`~/.conductor/runs/` for logs, event streams, patches, and pack renderings
([ADR-0003](adr/0003-state-store-sqlite.md)). Rows hold everything queryable;
blobs hold everything large. Every blob is referenced by an absolute path in
a row and by a sha256 where integrity matters (patches, packs).

## Schema

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  title TEXT NOT NULL, kind TEXT NOT NULL,
  repo_path TEXT NOT NULL, base_sha TEXT NOT NULL, branch TEXT NOT NULL,
  spec_json TEXT NOT NULL,                     -- frozen TaskSpec
  status TEXT NOT NULL                          -- queued | running | gated | paused | waiting_quota | done | escalated | aborted | crashed
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  status TEXT NOT NULL, outcome TEXT,          -- converged | escalated | aborted | crashed
  escalation_reason TEXT, pack_id TEXT,
  worktree_path TEXT, patch_path TEXT, patch_sha256 TEXT,
  rounds_used INTEGER, worker_runs_used INTEGER, wall_ms INTEGER,
  applied_at TEXT, applied_to_sha TEXT         -- set by `conductor apply`
);

CREATE TABLE rounds (
  run_id TEXT NOT NULL REFERENCES runs(id), n INTEGER NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT,
  debt_failing_steps INTEGER, debt_open_findings INTEGER,
  decision_json TEXT,                          -- LoopDecision
  PRIMARY KEY (run_id, n)
);

CREATE TABLE worker_runs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), round INTEGER NOT NULL,
  role TEXT NOT NULL, attempt INTEGER NOT NULL,   -- fix attempt / repair / retry index
  provider TEXT NOT NULL, adapter_version TEXT NOT NULL, cli_version TEXT NOT NULL,
  model_label TEXT, model_id TEXT, effort TEXT,
  session_ref TEXT, resumed_from TEXT,
  pack_id TEXT NOT NULL, prompt_sha256 TEXT NOT NULL, prompt_path TEXT NOT NULL,
  argv_json TEXT NOT NULL, optional_flags_json TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER,
  exit_code INTEGER, classification TEXT NOT NULL,
  usage_json TEXT, cost_usd REAL,
  events_path TEXT, stdout_path TEXT, stderr_path TEXT,
  output_valid INTEGER,                        -- 1 if the role's output file validated (after repair if any)
  diff_sha256 TEXT, files_changed INTEGER, insertions INTEGER, deletions INTEGER,
  same_vendor_review INTEGER DEFAULT 0
);

CREATE TABLE verification_steps (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, round INTEGER NOT NULL, attempt INTEGER NOT NULL,
  step_id TEXT NOT NULL, kind TEXT NOT NULL, command TEXT NOT NULL, required INTEGER NOT NULL,
  exit_code INTEGER, timed_out INTEGER, duration_ms INTEGER, passed INTEGER,
  failures_json TEXT, stdout_path TEXT, stderr_path TEXT,
  source TEXT NOT NULL                         -- repo | task | harvested:<finding_id>
);

CREATE TABLE findings (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, round INTEGER NOT NULL,
  worker_run_id TEXT NOT NULL REFERENCES worker_runs(id),
  label TEXT NOT NULL,                         -- model's "F1"
  severity TEXT NOT NULL, category TEXT NOT NULL, file TEXT, line INTEGER,
  claim TEXT NOT NULL, reproduction_kind TEXT NOT NULL,
  confirmation TEXT NOT NULL,                  -- confirmed | refuted | unappliable | needs_human | error | n/a (advice)
  is_advice INTEGER NOT NULL,
  regression_of TEXT, resolved_in_round INTEGER,
  finding_json TEXT NOT NULL
);

CREATE TABLE provider_events (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, at TEXT NOT NULL,
  kind TEXT NOT NULL,                          -- rate_limit_signal | rate_limited | auth_failed | model_rejected | cooling_start | cooling_end
  window TEXT, utilization REAL, resets_at TEXT, retry_after_ms INTEGER,
  worker_run_id TEXT, raw_json TEXT
);

CREATE TABLE provider_state (
  provider TEXT PRIMARY KEY, updated_at TEXT NOT NULL,
  utilization_5h REAL, utilization_7d REAL, resets_at_5h TEXT, resets_at_7d TEXT,
  cooling_until TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE provider_leases (
  provider TEXT NOT NULL, worker_run_id TEXT NOT NULL, holder_pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL,
  PRIMARY KEY (provider, worker_run_id)
);

CREATE TABLE capabilities_cache (
  adapter TEXT NOT NULL, binary_path TEXT NOT NULL, version TEXT NOT NULL, binary_mtime_ms INTEGER NOT NULL,
  probed_at TEXT NOT NULL, caps_json TEXT NOT NULL, rejected_models_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (adapter, binary_path, version, binary_mtime_ms)
);

CREATE TABLE annotations (                     -- the human labels
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT, at TEXT NOT NULL,
  outcome TEXT,                                -- merged | merged_with_edits | discarded | reworked_manually
  quality INTEGER,                             -- 1..5, operator's judgment of the final diff
  missed_defects_json TEXT,                    -- defects the operator found later that no reviewer caught
  note TEXT
);

CREATE TABLE gate_decisions (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, round INTEGER, gate TEXT NOT NULL, at TEXT NOT NULL,
  action TEXT NOT NULL,                        -- continue | add_finding | dismiss | abort
  payload_json TEXT
);
```

Indexes on `worker_runs(provider, model_id, role)`, `findings(worker_run_id)`,
`findings(confirmation)`, `verification_steps(run_id, round)`,
`provider_events(provider, at)`.

## What is persisted per worker run

Every invocation, including failed, killed, and repair turns:

- the exact prompt (blob + hash), the pack id, argv with secrets redacted,
  env keys (not values),
- the complete raw stdout/stderr and the normalized event stream (JSONL,
  with `raw` inline),
- adapter and CLI versions, model label and resolved id, effort,
- classification, exit code, duration, usage and cost when reported,
- the diff hash and stats of the worktree after the worker exited (for
  implementers and reproducers; reviewers' trees are hashed too, so that
  "the reviewer changed 14 files it was told not to" is on record).

## Retention

- Rows: forever. They are small and they are the corpus.
- Blobs: `conductor prune --older-than 90d` deletes event logs and step
  stdout/stderr for runs whose task is `done`, keeping prompts, patches,
  verdicts, and harvested files. Nothing is pruned automatically.
- Worktrees: deleted at `conductor rm <run>` or `conductor gc` (runs `done`
  and `applied` older than 7 days, or `crashed` older than 30 days). Never
  deleted while a run is `gated`, `paused`, or `escalated`.

## Observability while a run is live

`conductor run` prints a one-line-per-event log: step starts, tool calls
summarized, verification step results, confirmation results, decisions.
`conductor tail <run>` follows the same stream from the database for a run
started in another terminal. `conductor show <run>` renders the round records,
the findings table with confirmation status, and the paths to the worktree
and patch. `--json` on every read command.

## The corpus: what it can answer

The second-order prize. Each `worker_runs` row is a labeled sample. The
labels arrive from three sources: the conductor (verification, confirmation),
other workers (findings against an implementer), and you (`annotations`).

Questions the schema is designed to answer with plain SQL:

**Implementer quality, per (provider, model, task kind):**
- first-pass verification rate: `passed` on `attempt = 0` of round 1;
- confirmed findings raised against it per run;
- rounds to converge, worker runs to converge;
- gap between claims and facts: report says "tests pass" while verification
  failed;
- scope discipline: `files_changed` vs `touch_hint`;
- operator outcome: `annotations.outcome` and `quality`.

**Reviewer quality, per (provider, model):**
- precision: `confirmed / (confirmed + refuted)`;
- yield: confirmed findings per run;
- advice ratio: how much of its output could not act;
- recall proxy: `annotations.missed_defects_json` entries for runs it
  reviewed;
- cross-vendor vs same-vendor (`same_vendor_review`) precision and yield —
  this is the query that tests the premise of the whole project.

**Cost:** usage per role per task kind per provider; rate-limit events per
hour of day; how often the degradation ladder fired and which rung.

`conductor stats` ships a handful of these as canned reports. `conductor
export --jsonl` dumps joined rows for a notebook. Nothing leaves the machine
unless you run the export.

**Routing stays static config in v1.** The corpus exists so that when you
change a routing line, you can say why.

## Privacy

Prompts contain your source code. The database and blobs are local, mode
0600, and no telemetry exists. The export command has `--redact` which drops
prompt and log blobs and keeps only metrics, for sharing results without
sharing code.

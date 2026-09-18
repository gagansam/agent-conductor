/** Numbered migrations. Append only; never edit a shipped entry. PRAGMA user_version tracks the position. */
export const MIGRATIONS: string[] = [
  `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  title TEXT NOT NULL, kind TEXT NOT NULL,
  repo_path TEXT NOT NULL, base_sha TEXT NOT NULL, branch TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  status TEXT NOT NULL, outcome TEXT,
  escalation_reason TEXT, detail TEXT, pack_id TEXT,
  run_dir TEXT NOT NULL, worktree_path TEXT, patch_path TEXT, patch_sha256 TEXT,
  rounds_used INTEGER NOT NULL DEFAULT 0, worker_runs_used INTEGER NOT NULL DEFAULT 0, wall_ms INTEGER,
  pid INTEGER, heartbeat_at TEXT,
  applied_at TEXT, applied_to_sha TEXT
);
CREATE INDEX runs_task ON runs(task_id);

CREATE TABLE rounds (
  run_id TEXT NOT NULL REFERENCES runs(id), n INTEGER NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT,
  debt_failing_steps INTEGER, debt_open_findings INTEGER,
  decision_json TEXT,
  PRIMARY KEY (run_id, n)
);

CREATE TABLE worker_runs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), round INTEGER NOT NULL,
  role TEXT NOT NULL, slot TEXT NOT NULL, attempt INTEGER NOT NULL, purpose TEXT NOT NULL,
  provider TEXT NOT NULL, adapter_version TEXT NOT NULL, cli_version TEXT NOT NULL,
  model_label TEXT, model_id TEXT, effort TEXT,
  session_ref TEXT, resumed_from TEXT,
  pack_id TEXT NOT NULL, prompt_sha256 TEXT NOT NULL, prompt_path TEXT NOT NULL,
  argv_json TEXT NOT NULL DEFAULT '[]', optional_flags_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER,
  exit_code INTEGER, classification TEXT NOT NULL, detail TEXT,
  usage_json TEXT, cost_usd REAL,
  log_dir TEXT NOT NULL,
  output_valid INTEGER,
  diff_sha256 TEXT, files_changed INTEGER, insertions INTEGER, deletions INTEGER,
  audit_json TEXT,
  same_vendor_review INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX worker_runs_run ON worker_runs(run_id, round);
CREATE INDEX worker_runs_model ON worker_runs(provider, model_id, role);

CREATE TABLE verification_steps (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, round INTEGER NOT NULL, attempt INTEGER NOT NULL,
  step_id TEXT NOT NULL, kind TEXT NOT NULL, command TEXT NOT NULL, required INTEGER NOT NULL,
  exit_code INTEGER, timed_out INTEGER NOT NULL, duration_ms INTEGER NOT NULL, passed INTEGER NOT NULL,
  failures_json TEXT NOT NULL, stdout_path TEXT NOT NULL, stderr_path TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX verification_steps_run ON verification_steps(run_id, round);

CREATE TABLE findings (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, round INTEGER NOT NULL,
  worker_run_id TEXT NOT NULL REFERENCES worker_runs(id),
  label TEXT NOT NULL,
  severity TEXT NOT NULL, category TEXT NOT NULL, file TEXT, line INTEGER,
  claim TEXT NOT NULL, reproduction_kind TEXT NOT NULL,
  confirmation TEXT NOT NULL,
  is_advice INTEGER NOT NULL,
  regression_of TEXT, resolved_in_round INTEGER,
  finding_json TEXT NOT NULL
);
CREATE INDEX findings_worker ON findings(worker_run_id);
CREATE INDEX findings_confirmation ON findings(confirmation);
CREATE INDEX findings_run ON findings(run_id, round);

CREATE TABLE verdicts (
  worker_run_id TEXT PRIMARY KEY REFERENCES worker_runs(id),
  run_id TEXT NOT NULL, round INTEGER NOT NULL,
  decision TEXT NOT NULL, summary TEXT NOT NULL, confidence REAL,
  advice_count INTEGER NOT NULL, verdict_json TEXT NOT NULL
);

CREATE TABLE provider_events (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, at TEXT NOT NULL,
  kind TEXT NOT NULL,
  window TEXT, utilization REAL, resets_at TEXT, retry_after_ms INTEGER,
  worker_run_id TEXT, raw_json TEXT
);
CREATE INDEX provider_events_at ON provider_events(provider, at);

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

CREATE TABLE annotations (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT, at TEXT NOT NULL,
  outcome TEXT, quality INTEGER, missed_defects_json TEXT, note TEXT
);

CREATE TABLE gate_decisions (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, round INTEGER, gate TEXT NOT NULL, at TEXT NOT NULL,
  action TEXT NOT NULL, payload_json TEXT
);
`,
];

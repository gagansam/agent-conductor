import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { CapabilitySet, WorkerResult } from '@agent-conductor/adapter-api';
import type { Debt, LoopDecision, RunOutcome, RunStatus } from '../contracts/round.js';
import type { TaskSpec } from '../contracts/task.js';
import type { Finding, Verdict } from '../contracts/verdict.js';
import type { StepResult } from '../contracts/verification.js';
import type { PatchInfo } from '../contracts/work-product.js';
import { nowIso, ulid } from '../ids.js';
import type { AuditViolation } from '../isolation/audit.js';
import { MIGRATIONS } from './schema.js';

type Row = Record<string, SQLInputValue>;

export interface RunRow {
  id: string;
  task_id: string;
  attempt: number;
  started_at: string;
  ended_at: string | null;
  status: RunStatus;
  outcome: RunOutcome | null;
  escalation_reason: string | null;
  detail: string | null;
  pack_id: string | null;
  run_dir: string;
  worktree_path: string | null;
  patch_path: string | null;
  patch_sha256: string | null;
  rounds_used: number;
  worker_runs_used: number;
  wall_ms: number | null;
  pid: number | null;
  applied_at: string | null;
  applied_to_sha: string | null;
}

export interface TaskRow {
  id: string;
  created_at: string;
  title: string;
  kind: string;
  repo_path: string;
  base_sha: string;
  branch: string;
  spec_json: string;
  status: RunStatus;
}

export interface WorkerRunRow {
  id: string;
  run_id: string;
  round: number;
  role: string;
  slot: string;
  attempt: number;
  purpose: string;
  provider: string;
  cli_version: string;
  model_label: string | null;
  model_id: string | null;
  classification: string;
  detail: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  output_valid: number | null;
  usage_json: string | null;
  cost_usd: number | null;
  log_dir: string;
  files_changed: number | null;
  insertions: number | null;
  deletions: number | null;
  audit_json: string | null;
  same_vendor_review: number;
  session_ref: string | null;
}

export interface NewWorkerRun {
  id: string;
  run_id: string;
  round: number;
  role: string;
  slot: string;
  attempt: number;
  /** work | fix | repair | retry */
  purpose: string;
  provider: string;
  adapter_version: string;
  cli_version: string;
  model_label?: string;
  model_id?: string;
  effort?: string;
  resumed_from?: string;
  pack_id: string;
  prompt_sha256: string;
  prompt_path: string;
  log_dir: string;
  same_vendor_review?: boolean;
}

export interface ProviderState {
  provider: string;
  utilization_5h: number | null;
  utilization_7d: number | null;
  resets_at_5h: string | null;
  resets_at_7d: string | null;
  cooling_until: string | null;
  consecutive_failures: number;
}

const LEASE_STALE_MS = 60_000;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  static open(file: string): Store {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const store = new Store(db);
    store.migrate();
    // Prompts contain source code.
    if (file !== ':memory:') chmodSync(file, 0o600);
    return store;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  private run(sql: string, params: Row = {}): void {
    this.db.prepare(sql).run(params);
  }
  private all<T>(sql: string, params: Row = {}): T[] {
    return this.db.prepare(sql).all(params) as T[];
  }
  private one<T>(sql: string, params: Row = {}): T | undefined {
    return this.db.prepare(sql).get(params) as T | undefined;
  }
  private insert(table: string, row: Row): void {
    const cols = Object.keys(row);
    this.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`, row);
  }
  private update(table: string, where: Row, set: Row): void {
    const sets = Object.keys(set).map((c) => `${c} = :${c}`);
    const wheres = Object.keys(where).map((c) => `${c} = :w_${c}`);
    const params: Row = { ...set };
    for (const [k, v] of Object.entries(where)) params[`w_${k}`] = v;
    this.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${wheres.join(' AND ')}`, params);
  }

  // ---- tasks and runs -------------------------------------------------------

  insertTask(task: TaskSpec, base_sha: string, branch: string): void {
    this.insert('tasks', {
      id: task.id,
      created_at: nowIso(),
      title: task.title,
      kind: task.kind,
      repo_path: task.repo.path_abs,
      base_sha,
      branch,
      spec_json: JSON.stringify(task),
      status: 'running',
    });
  }

  setTaskStatus(task_id: string, status: RunStatus): void {
    this.update('tasks', { id: task_id }, { status });
  }

  insertRun(run: { id: string; task_id: string; run_dir: string; pid: number }): void {
    const prior = this.one<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE task_id = :t', { t: run.task_id });
    this.insert('runs', {
      id: run.id,
      task_id: run.task_id,
      attempt: (prior?.n ?? 0) + 1,
      started_at: nowIso(),
      status: 'running',
      run_dir: run.run_dir,
      pid: run.pid,
      heartbeat_at: nowIso(),
    });
  }

  updateRun(id: string, set: Partial<Omit<RunRow, 'id' | 'task_id'>> & { heartbeat_at?: string }): void {
    if (Object.keys(set).length) this.update('runs', { id }, set as Row);
  }

  bumpRun(id: string, col: 'rounds_used' | 'worker_runs_used'): void {
    this.run(`UPDATE runs SET ${col} = ${col} + 1 WHERE id = :id`, { id });
  }

  /** Exact id, or a unique prefix / suffix. Runs are ULIDs; operators type the last few characters. */
  findRun(ref: string): RunRow | undefined {
    const exact = this.one<RunRow>('SELECT * FROM runs WHERE id = :id', { id: ref });
    if (exact) return exact;
    const like = this.all<RunRow>('SELECT * FROM runs WHERE id LIKE :p OR id LIKE :s', { p: `${ref}%`, s: `%${ref}` });
    return like.length === 1 ? like[0] : undefined;
  }

  latestRun(): RunRow | undefined {
    return this.one<RunRow>('SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT 1');
  }

  listRuns(limit = 20): (RunRow & { title: string; kind: string; repo_path: string })[] {
    return this.all(
      `SELECT r.*, t.title, t.kind, t.repo_path FROM runs r JOIN tasks t ON t.id = r.task_id
       ORDER BY r.started_at DESC, r.id DESC LIMIT :limit`,
      { limit },
    );
  }

  getTask(id: string): TaskRow | undefined {
    return this.one<TaskRow>('SELECT * FROM tasks WHERE id = :id', { id });
  }

  // ---- rounds ---------------------------------------------------------------

  insertRound(run_id: string, n: number): void {
    this.insert('rounds', { run_id, n, started_at: nowIso() });
    this.bumpRun(run_id, 'rounds_used');
  }

  finishRound(run_id: string, n: number, debt: Debt, decision: LoopDecision): void {
    this.update(
      'rounds',
      { run_id, n },
      {
        ended_at: nowIso(),
        debt_failing_steps: debt.failing_required_steps,
        debt_open_findings: debt.confirmed_open_findings,
        decision_json: JSON.stringify(decision),
      },
    );
  }

  rounds(run_id: string): { n: number; started_at: string; ended_at: string | null; debt_failing_steps: number | null; debt_open_findings: number | null; decision_json: string | null }[] {
    return this.all('SELECT * FROM rounds WHERE run_id = :run_id ORDER BY n', { run_id });
  }

  // ---- worker runs ----------------------------------------------------------

  insertWorkerRun(w: NewWorkerRun): void {
    this.insert('worker_runs', {
      id: w.id,
      run_id: w.run_id,
      round: w.round,
      role: w.role,
      slot: w.slot,
      attempt: w.attempt,
      purpose: w.purpose,
      provider: w.provider,
      adapter_version: w.adapter_version,
      cli_version: w.cli_version,
      model_label: w.model_label ?? null,
      model_id: w.model_id ?? null,
      effort: w.effort ?? null,
      resumed_from: w.resumed_from ?? null,
      pack_id: w.pack_id,
      prompt_sha256: w.prompt_sha256,
      prompt_path: w.prompt_path,
      started_at: nowIso(),
      classification: 'running',
      log_dir: w.log_dir,
      same_vendor_review: w.same_vendor_review ? 1 : 0,
    });
    this.bumpRun(w.run_id, 'worker_runs_used');
  }

  finishWorkerRun(id: string, result: WorkerResult, classification: string, detail?: string): void {
    this.update(
      'worker_runs',
      { id },
      {
        ended_at: nowIso(),
        duration_ms: result.duration_ms,
        exit_code: result.exit_code,
        classification,
        detail: detail ?? result.detail ?? null,
        session_ref: result.session_ref ?? null,
        argv_json: JSON.stringify(result.argv),
        optional_flags_json: JSON.stringify(result.optional_flags_used),
        usage_json: result.usage ? JSON.stringify(result.usage) : null,
        cost_usd: result.usage?.cost_usd ?? null,
      },
    );
  }

  annotateWorkerRun(id: string, set: { classification?: string; detail?: string; output_valid?: boolean; patch?: PatchInfo; audit?: AuditViolation[] }): void {
    const row: Row = {};
    if (set.classification !== undefined) row.classification = set.classification;
    if (set.detail !== undefined) row.detail = set.detail;
    if (set.output_valid !== undefined) row.output_valid = set.output_valid ? 1 : 0;
    if (set.patch) {
      row.diff_sha256 = set.patch.sha256;
      row.files_changed = set.patch.files_changed.length;
      row.insertions = set.patch.insertions;
      row.deletions = set.patch.deletions;
    }
    if (set.audit) row.audit_json = JSON.stringify(set.audit);
    if (Object.keys(row).length) this.update('worker_runs', { id }, row);
  }

  workerRuns(run_id: string): WorkerRunRow[] {
    return this.all('SELECT * FROM worker_runs WHERE run_id = :run_id ORDER BY started_at, id', { run_id });
  }

  // ---- verification, verdicts, findings -------------------------------------

  insertVerificationStep(run_id: string, round: number, attempt: number, s: StepResult): void {
    this.insert('verification_steps', {
      id: ulid(),
      run_id,
      round,
      attempt,
      step_id: s.step_id,
      kind: s.kind,
      command: s.command,
      required: s.required ? 1 : 0,
      exit_code: s.exit_code,
      timed_out: s.timed_out ? 1 : 0,
      duration_ms: s.duration_ms,
      passed: s.passed ? 1 : 0,
      failures_json: JSON.stringify(s.failures),
      stdout_path: s.stdout_path_abs,
      stderr_path: s.stderr_path_abs,
      source: s.source,
    });
  }

  verificationSteps(run_id: string): { round: number; attempt: number; step_id: string; kind: string; command: string; required: number; exit_code: number | null; timed_out: number; duration_ms: number; passed: number; failures_json: string; stdout_path: string; stderr_path: string; source: string }[] {
    return this.all('SELECT * FROM verification_steps WHERE run_id = :run_id ORDER BY round, attempt, rowid', { run_id });
  }

  insertVerdict(v: Verdict): void {
    this.insert('verdicts', {
      worker_run_id: v.reviewer.worker_run_id,
      run_id: v.run_id,
      round: v.round,
      decision: v.decision,
      summary: v.summary,
      confidence: v.confidence,
      advice_count: v.advice.length + v.findings.filter((f) => f.is_advice).length,
      verdict_json: JSON.stringify(v),
    });
    for (const f of v.findings) this.insertFinding(v.run_id, v.round, v.reviewer.worker_run_id, f);
  }

  private insertFinding(run_id: string, round: number, worker_run_id: string, f: Finding): void {
    this.insert('findings', {
      id: f.uid,
      run_id,
      round,
      worker_run_id,
      label: f.id,
      severity: f.severity,
      category: f.category,
      file: f.file,
      line: f.line ?? null,
      claim: f.claim,
      reproduction_kind: f.reproduction.kind,
      confirmation: f.confirmation.status,
      is_advice: f.is_advice ? 1 : 0,
      regression_of: f.regression_of ?? null,
      finding_json: JSON.stringify(f),
    });
  }

  resolveFinding(uid: string, round: number): void {
    this.update('findings', { id: uid }, { resolved_in_round: round });
  }

  verdicts(run_id: string): Verdict[] {
    return this.all<{ verdict_json: string }>('SELECT verdict_json FROM verdicts WHERE run_id = :run_id ORDER BY round, worker_run_id', { run_id }).map(
      (r) => JSON.parse(r.verdict_json) as Verdict,
    );
  }

  findings(run_id: string): { id: string; round: number; label: string; severity: string; category: string; file: string | null; line: number | null; claim: string; reproduction_kind: string; confirmation: string; is_advice: number; resolved_in_round: number | null; finding_json: string }[] {
    return this.all('SELECT * FROM findings WHERE run_id = :run_id ORDER BY round, rowid', { run_id });
  }

  // ---- gates ----------------------------------------------------------------

  insertGateDecision(run_id: string, round: number, gate: string, action: string, payload?: unknown): void {
    this.insert('gate_decisions', { id: ulid(), run_id, round, gate, at: nowIso(), action, payload_json: payload === undefined ? null : JSON.stringify(payload) });
  }

  // ---- providers ------------------------------------------------------------

  recordProviderEvent(e: { provider: string; kind: string; window?: string; utilization?: number; resets_at?: string; retry_after_ms?: number; worker_run_id?: string; raw?: unknown }): void {
    this.insert('provider_events', {
      provider: e.provider,
      at: nowIso(),
      kind: e.kind,
      window: e.window ?? null,
      utilization: e.utilization ?? null,
      resets_at: e.resets_at ?? null,
      retry_after_ms: e.retry_after_ms ?? null,
      worker_run_id: e.worker_run_id ?? null,
      raw_json: e.raw === undefined ? null : JSON.stringify(e.raw),
    });
  }

  providerState(provider: string): ProviderState {
    const row = this.one<ProviderState>('SELECT * FROM provider_state WHERE provider = :provider', { provider });
    return row ?? { provider, utilization_5h: null, utilization_7d: null, resets_at_5h: null, resets_at_7d: null, cooling_until: null, consecutive_failures: 0 };
  }

  setProviderState(provider: string, set: Partial<Omit<ProviderState, 'provider'>>): void {
    const merged = { ...this.providerState(provider), ...set };
    this.run(
      `INSERT INTO provider_state (provider, updated_at, utilization_5h, utilization_7d, resets_at_5h, resets_at_7d, cooling_until, consecutive_failures)
       VALUES (:provider, :updated_at, :utilization_5h, :utilization_7d, :resets_at_5h, :resets_at_7d, :cooling_until, :consecutive_failures)
       ON CONFLICT(provider) DO UPDATE SET updated_at = excluded.updated_at, utilization_5h = excluded.utilization_5h,
         utilization_7d = excluded.utilization_7d, resets_at_5h = excluded.resets_at_5h, resets_at_7d = excluded.resets_at_7d,
         cooling_until = excluded.cooling_until, consecutive_failures = excluded.consecutive_failures`,
      { ...merged, updated_at: nowIso() },
    );
  }

  /**
   * Leases live in the database so that two `conductor run` processes share a
   * provider's concurrency limit. Stale or orphaned leases are reaped by
   * whoever looks next.
   */
  tryAcquireLease(provider: string, max_concurrent: number, worker_run_id: string, pid = process.pid): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const leases = this.all<{ worker_run_id: string; holder_pid: number; heartbeat_at: string }>(
        'SELECT worker_run_id, holder_pid, heartbeat_at FROM provider_leases WHERE provider = :provider',
        { provider },
      );
      let live = 0;
      for (const l of leases) {
        const stale = Date.now() - Date.parse(l.heartbeat_at) > LEASE_STALE_MS || !pidAlive(l.holder_pid);
        if (stale) this.run('DELETE FROM provider_leases WHERE provider = :provider AND worker_run_id = :w', { provider, w: l.worker_run_id });
        else live++;
      }
      const ok = live < max_concurrent;
      if (ok) this.insert('provider_leases', { provider, worker_run_id, holder_pid: pid, acquired_at: nowIso(), heartbeat_at: nowIso() });
      this.db.exec('COMMIT');
      return ok;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  heartbeatLease(provider: string, worker_run_id: string): void {
    this.update('provider_leases', { provider, worker_run_id }, { heartbeat_at: nowIso() });
  }

  releaseLease(provider: string, worker_run_id: string): void {
    this.run('DELETE FROM provider_leases WHERE provider = :provider AND worker_run_id = :w', { provider, w: worker_run_id });
  }

  // ---- capabilities cache ---------------------------------------------------

  cachedCapabilities(key: { adapter: string; binary_path: string; version: string; binary_mtime_ms: number }): CapabilitySet | undefined {
    const row = this.one<{ caps_json: string }>(
      'SELECT caps_json FROM capabilities_cache WHERE adapter = :adapter AND binary_path = :binary_path AND version = :version AND binary_mtime_ms = :binary_mtime_ms',
      key,
    );
    return row ? (JSON.parse(row.caps_json) as CapabilitySet) : undefined;
  }

  cacheCapabilities(key: { adapter: string; binary_path: string; version: string; binary_mtime_ms: number }, caps: CapabilitySet): void {
    this.run(
      `INSERT OR REPLACE INTO capabilities_cache (adapter, binary_path, version, binary_mtime_ms, probed_at, caps_json)
       VALUES (:adapter, :binary_path, :version, :binary_mtime_ms, :probed_at, :caps_json)`,
      { ...key, probed_at: nowIso(), caps_json: JSON.stringify(caps) },
    );
  }
}

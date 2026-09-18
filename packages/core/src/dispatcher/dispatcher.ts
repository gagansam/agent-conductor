import { existsSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Classification, SandboxPolicy, WorkerEvent, WorkerHandle, WorkerJob, WorkerResult } from '@agent-conductor/adapter-api';
import type { ResolvedTarget } from '../config/load.js';
import type { LoopConfig } from '../config/schema.js';
import { OUT_DIR_REL, roleOutput } from '../contracts/json-schema.js';
import type { Role } from '../contracts/task.js';
import type { Observer } from '../events.js';
import { ulid } from '../ids.js';
import type { Store } from '../store/store.js';
import type { ProviderRuntime } from './providers.js';

export class BudgetExceeded extends Error {
  constructor(readonly limit: number) {
    super(`worker run budget exhausted (max_worker_runs = ${limit})`);
    this.name = 'BudgetExceeded';
  }
}

export class DispatchPaused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchPaused';
  }
}

export interface DispatchRequest {
  run_id: string;
  round: number;
  role: Role;
  attempt: number;
  purpose: 'work' | 'fix' | 'repair';
  target: ResolvedTarget;
  cwd_abs: string;
  prompt: string;
  prompt_sha256: string;
  prompt_path_abs: string;
  pack_id: string;
  policy: SandboxPolicy;
  /** Each invocation gets `<log_root>/<worker_run_id>/`. */
  log_root_abs: string;
  resume_session?: string;
  same_vendor_review?: boolean;
}

export interface DispatchOutcome {
  worker_run_id: string;
  provider: ProviderRuntime;
  result: WorkerResult;
  log_dir_abs: string;
}

export interface DispatcherOptions {
  store: Store;
  providers: Map<string, ProviderRuntime>;
  loop: LoopConfig;
  max_worker_runs: number;
  stop_file: string;
  observer: Observer;
  signal: AbortSignal;
}

const KILL_GRACE_MS = 10_000;
const LEASE_POLL_MS = 2_000;
const HEARTBEAT_MS = 15_000;
/** Worth one more try with every optional flag dropped: the CLI refused our argv or config, not our work. */
const FLAG_FAILURES: ReadonlySet<Classification> = new Set(['config_rejected', 'cli_usage_error']);
/** A failed resume is retried fresh unless the failure had nothing to do with resuming. */
const NOT_RESUME_RELATED: ReadonlySet<Classification> = new Set(['ok', 'killed', 'timeout_idle', 'timeout_total', 'rate_limited', 'auth_failed']);

export class Dispatcher {
  private used = 0;
  constructor(private readonly o: DispatcherOptions) {}

  get workerRunsUsed(): number {
    return this.used;
  }

  canSpawn(): boolean {
    return this.used < this.o.max_worker_runs;
  }

  /**
   * One step. Applies the two retry policies the dispatcher owns (drop
   * optional flags; retry a failed resume fresh). Everything else is the
   * engine's call. Every spawn counts against max_worker_runs.
   */
  async dispatch(req: DispatchRequest): Promise<DispatchOutcome> {
    let outcome = await this.spawnOnce(req, {});
    let c = outcome.result.classification;
    if (FLAG_FAILURES.has(c) && this.canSpawn()) {
      this.o.observer({ type: 'warning', message: `${req.target.provider} rejected its arguments (${c}); retrying with optional flags dropped` });
      outcome = await this.spawnOnce(req, { no_optional_flags: true });
      c = outcome.result.classification;
    }
    // Not `else`: a CLI whose resume syntax changed fails as a usage error first, and a fresh session still rescues it.
    if (req.resume_session && !NOT_RESUME_RELATED.has(c) && this.canSpawn()) {
      this.o.observer({ type: 'warning', message: `resuming session ${req.resume_session} failed (${c}); retrying in a fresh session` });
      const { resume_session: _dropped, ...fresh } = req;
      outcome = await this.spawnOnce(fresh, {});
    }
    return outcome;
  }

  private async spawnOnce(req: DispatchRequest, flags: { no_optional_flags?: boolean }): Promise<DispatchOutcome> {
    const provider = this.o.providers.get(req.target.provider);
    if (!provider) throw new Error(`provider "${req.target.provider}" was not prepared`);
    if (this.o.signal.aborted) throw new DispatchPaused('run aborted');
    if (existsSync(this.o.stop_file)) throw new DispatchPaused(`${this.o.stop_file} exists; nothing new will be started until it is removed`);
    if (!this.canSpawn()) throw new BudgetExceeded(this.o.max_worker_runs);

    const worker_run_id = ulid();
    const log_dir_abs = `${req.log_root_abs}/${worker_run_id}`;
    // The dispatcher owns this directory; adapters and the engine both write into it.
    mkdirSync(log_dir_abs, { recursive: true });
    await this.acquireLease(provider, worker_run_id);
    this.used++;

    const resume = req.resume_session && provider.caps.resume ? { session_ref: req.resume_session } : undefined;
    const out = roleOutput(req.role);
    const job: WorkerJob = {
      worker_run_id,
      role: req.role,
      cwd_abs: req.cwd_abs,
      prompt: req.prompt,
      model_id: req.target.model_id,
      ...(req.target.effort ? { effort: req.target.effort } : {}),
      policy: req.policy,
      output: { dir_rel: OUT_DIR_REL, files: [{ path_rel: out.path_rel, schema: out.json_schema }] },
      ...(resume ? { resume } : {}),
      timeouts: { idle_ms: this.o.loop.idle_timeout_ms, total_ms: this.o.loop.worker_total_timeout_ms },
      env: { CONDUCTOR_RUN_ID: req.run_id, CONDUCTOR_ROLE: req.role },
      log_dir_abs,
      ...(flags.no_optional_flags ? { no_optional_flags: true } : {}),
    };

    this.o.store.insertWorkerRun({
      id: worker_run_id,
      run_id: req.run_id,
      round: req.round,
      role: req.role,
      slot: req.target.slot,
      attempt: req.attempt,
      purpose: flags.no_optional_flags ? `${req.purpose}:bare` : req.purpose,
      provider: provider.name,
      adapter_version: `${provider.adapter.id}@api${provider.adapter.apiVersion}`,
      cli_version: provider.detection.version,
      model_label: req.target.model,
      model_id: req.target.model_id,
      ...(req.target.effort ? { effort: req.target.effort } : {}),
      ...(resume ? { resumed_from: resume.session_ref } : {}),
      pack_id: req.pack_id,
      prompt_sha256: req.prompt_sha256,
      prompt_path: req.prompt_path_abs,
      log_dir: log_dir_abs,
      ...(req.same_vendor_review ? { same_vendor_review: true } : {}),
    });
    this.o.observer({ type: 'worker_started', worker_run_id, role: req.role, slot: req.target.slot, provider: provider.name, model_id: req.target.model_id, purpose: req.purpose, log_dir: log_dir_abs, cwd: req.cwd_abs });

    let result: WorkerResult;
    try {
      const handle = provider.adapter.start(job, provider.detection, provider.caps);
      result = await this.supervise(handle, provider, job, req.role);
    } catch (e) {
      // An adapter that throws is a crashed worker, not a crashed conductor.
      result = { exit_code: null, classification: 'crashed', final_text: '', duration_ms: 0, argv: [], optional_flags_used: [], events_path_abs: `${log_dir_abs}/events.jsonl`, detail: `adapter threw: ${String(e)}` };
    } finally {
      this.o.store.releaseLease(provider.name, worker_run_id);
    }

    this.o.store.finishWorkerRun(worker_run_id, result, result.classification);
    this.noteProviderHealth(provider.name, result, worker_run_id);
    this.o.observer({ type: 'worker_finished', worker_run_id, role: req.role, classification: result.classification, duration_ms: result.duration_ms, ...(result.detail ? { detail: result.detail } : {}) });
    return { worker_run_id, provider, result, log_dir_abs };
  }

  private async acquireLease(provider: ProviderRuntime, worker_run_id: string): Promise<void> {
    let announced = false;
    while (!this.o.store.tryAcquireLease(provider.name, provider.config.max_concurrent, worker_run_id)) {
      if (!announced) {
        this.o.observer({ type: 'warning', message: `waiting for a free ${provider.name} slot (max_concurrent = ${provider.config.max_concurrent})` });
        announced = true;
      }
      if (this.o.signal.aborted) throw new DispatchPaused('run aborted while waiting for a provider slot');
      await sleep(LEASE_POLL_MS);
    }
  }

  /** Enforce timeouts and the abort signal; forward events; keep the lease alive. */
  private async supervise(handle: WorkerHandle, provider: ProviderRuntime, job: WorkerJob, role: Role): Promise<WorkerResult> {
    let idleTimer: NodeJS.Timeout | undefined;
    const terminate = (reason: 'killed' | 'timeout_idle' | 'timeout_total'): void => {
      handle.kill('SIGTERM', reason);
      setTimeout(() => handle.kill('SIGKILL', reason), KILL_GRACE_MS).unref();
    };
    const armIdle = (): void => {
      if (!provider.caps.streaming_events) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => terminate('timeout_idle'), job.timeouts.idle_ms);
    };
    const totalTimer = setTimeout(() => terminate('timeout_total'), job.timeouts.total_ms);
    const heartbeat = setInterval(() => this.o.store.heartbeatLease(provider.name, job.worker_run_id), HEARTBEAT_MS);
    const onAbort = (): void => terminate('killed');
    if (this.o.signal.aborted) onAbort();
    else this.o.signal.addEventListener('abort', onAbort, { once: true });
    armIdle();

    const pump = (async (): Promise<void> => {
      for await (const event of handle.events) {
        armIdle();
        if (event.kind === 'rate_limit') this.noteRateLimit(provider.name, job.worker_run_id, event);
        this.o.observer({ type: 'worker_event', worker_run_id: job.worker_run_id, role, event });
      }
    })();

    try {
      const [result] = await Promise.all([handle.result, pump]);
      return result;
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      clearInterval(heartbeat);
      this.o.signal.removeEventListener('abort', onAbort);
    }
  }

  private noteRateLimit(provider: string, worker_run_id: string, e: Extract<WorkerEvent, { kind: 'rate_limit' }>): void {
    this.o.store.recordProviderEvent({
      provider,
      kind: 'rate_limit_signal',
      ...(e.window !== undefined ? { window: e.window } : {}),
      ...(e.utilization !== undefined ? { utilization: e.utilization } : {}),
      ...(e.resets_at !== undefined ? { resets_at: e.resets_at } : {}),
      ...(e.retry_after_ms !== undefined ? { retry_after_ms: e.retry_after_ms } : {}),
      worker_run_id,
      raw: e.raw,
    });
    // A rejection with a known reset time is a cooling period. Nothing gates on it yet (M3); it is recorded so it can.
    if (e.status && /reject/i.test(e.status) && e.resets_at) this.o.store.setProviderState(provider, { cooling_until: e.resets_at });
    if (e.utilization === undefined) return;
    if (e.window === 'five_hour') this.o.store.setProviderState(provider, { utilization_5h: e.utilization, resets_at_5h: e.resets_at ?? null });
    if (e.window === 'seven_day') this.o.store.setProviderState(provider, { utilization_7d: e.utilization, resets_at_7d: e.resets_at ?? null });
  }

  private noteProviderHealth(provider: string, result: WorkerResult, worker_run_id: string): void {
    const c = result.classification;
    if (c === 'ok') {
      this.o.store.setProviderState(provider, { consecutive_failures: 0 });
      return;
    }
    if (c === 'rate_limited' || c === 'auth_failed' || c === 'model_rejected') {
      this.o.store.recordProviderEvent({ provider, kind: c, worker_run_id, raw: { detail: result.detail } });
    }
    if (c === 'crashed' || c === 'vendor_error') {
      const st = this.o.store.providerState(provider);
      this.o.store.setProviderState(provider, { consecutive_failures: st.consecutive_failures + 1 });
    }
  }
}

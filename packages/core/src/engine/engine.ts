import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerAdapter } from '@agent-conductor/adapter-api';
import { loadRepoConfig, resolveRoles, type Paths, type ResolvedTarget } from '../config/load.js';
import { buildPolicy } from '../config/policy.js';
import type { GlobalConfig, RepoConfig } from '../config/schema.js';
import { MAX_QUESTIONS, type Clarification, type ClarificationStage, type OwnChoice, type Question, type QuestionsOutput } from '../contracts/clarify.js';
import type { PackBase, PriorRound } from '../contracts/pack.js';
import type { Debt, EscalationReason, FixTarget, LoopDecision, RunOutcome, RunStatus } from '../contracts/round.js';
import type { Gate, Role, TaskSpec } from '../contracts/task.js';
import type { Finding, Verdict, VerdictOutput } from '../contracts/verdict.js';
import type { VerificationResult } from '../contracts/verification.js';
import type { ImplementerReport, PatchInfo } from '../contracts/work-product.js';
import { confirmFindings } from '../confirmer/confirmer.js';
import { BudgetExceeded, DispatchPaused, Dispatcher, type DispatchOutcome, type DispatchRequest } from '../dispatcher/dispatcher.js';
import { prepareProviders, type ProviderRuntime } from '../dispatcher/providers.js';
import type { Observer } from '../events.js';
import { currentBranch, revParse } from '../git/exec.js';
import { ulid } from '../ids.js';
import { loadInstructions } from '../instructions/load.js';
import { auditWorktree, snapshotGit } from '../isolation/audit.js';
import { applyPatch, extractPatch, worktreeState } from '../isolation/diff.js';
import { restoreHarvested } from '../isolation/harvest.js';
import { setupWorktree } from '../isolation/setup.js';
import { createWorktree, ensureHooksDir, removeWorktree } from '../isolation/worktree.js';
import { askingSection, loadExcerpts, packId, renderPack } from '../pack/render.js';
import type { Store } from '../store/store.js';
import { buildPlan, describePlan, runVerification, summarize, type PlannedStep } from '../verifier/verifier.js';
import { readRoleOutput, repairPrompt } from './output.js';

export interface GateRequest {
  gate: Gate;
  round: number;
  summary: string;
  needs_human: Finding[];
}
export type GateAnswer = 'continue' | 'abort';
export type GateHandler = (req: GateRequest) => Promise<GateAnswer>;
export interface QuestionsRequest {
  stage: 'before_coding' | 'blocking';
  questions: Question[];
  /** Aborted when the answer timeout expires; the handler should stop waiting. */
  signal: AbortSignal;
}
/** Shows the implementer's questions. Returns question id → answer; a missing id means "use its recommendation". */
export type QuestionsHandler = (req: QuestionsRequest) => Promise<Record<string, string>>;

export interface ChoicesRequest {
  choices: OwnChoice[];
  signal: AbortSignal;
}
/** Shows the implementer's own judgment calls. Returns choice id → the operator's answer, for overruled ones only. */
export type ChoicesHandler = (req: ChoicesRequest) => Promise<Record<string, string>>;

export interface EngineOptions {
  store: Store;
  paths: Paths;
  global: GlobalConfig;
  /** provider name → adapter instance. The host builds these; the core never imports an adapter. */
  adapters: Record<string, WorkerAdapter>;
  observer?: Observer;
  /** Absent ⇒ gates pass automatically, and findings only a human can judge escalate. */
  gate?: GateHandler;
  signal?: AbortSignal;
  /** Skip the baseline check for this run (overrides loop.verify_baseline). */
  skip_baseline?: boolean;
  /**
   * Absent ⇒ nobody is there: the implementer is told to decide everything itself, its questions get its own
   * recommendations, and everything assumed is listed in the summary.
   */
  questions?: QuestionsHandler;
  /** Absent ⇒ the implementer's own choices are recorded as unconfirmed, not reviewed. */
  choices?: ChoicesHandler;
}

export interface RunSummary {
  run_id: string;
  task_id: string;
  outcome: RunOutcome;
  status: RunStatus;
  escalation_reason?: EscalationReason | 'needs_human';
  detail: string;
  run_dir: string;
  worktree: string;
  patch_path?: string;
  patch?: PatchInfo;
  rounds: number;
  worker_runs: number;
  open_findings: Finding[];
  needs_human: Finding[];
  advice_count: number;
  /** Reproduction files of still-open findings: in the worktree, left out of the patch. */
  open_repro_files: string[];
  /** Questions asked before coding, and how each was answered. */
  clarifications: Clarification[];
  /** From the implementer's last report: what it wants the operator to decide, and what it deliberately left out. */
  open_questions: string[];
  did_not_do: string[];
}

type Stop =
  | { outcome: 'converged'; detail: string }
  | { outcome: 'escalated'; reason: EscalationReason | 'needs_human'; detail: string }
  | { outcome: 'aborted'; reason: 'budget' | 'operator' | 'unrecoverable'; detail: string };

interface HarvestRecord {
  finding_uid: string;
  files: string[];
  keep_dir: string;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export async function runTask(task: TaskSpec, o: EngineOptions): Promise<RunSummary> {
  return new Run(task, o).execute();
}

class Run {
  private readonly observer: Observer;
  private readonly run_id = ulid();
  private readonly run_dir: string;
  private readonly wt_root: string;
  private readonly impl: string;
  private readonly ac = new AbortController();
  private readonly started = Date.now();

  private repoCfg!: RepoConfig;
  private implementer!: ResolvedTarget;
  private reviewers: { target: ResolvedTarget; same_vendor: boolean }[] = [];
  private providers!: Map<string, ProviderRuntime>;
  private dispatcher!: Dispatcher;
  private base_sha = '';
  private branch = '';
  private baseStatic!: Omit<PackBase, 'prior' | 'decisions'>;

  private round = 0;
  private prior: PriorRound[] = [];
  private decisions: string[] = [];
  private harvestedSteps: PlannedStep[] = [];
  private harvested: HarvestRecord[] = [];
  private openFindings: Finding[] = [];
  private needsHuman: Finding[] = [];
  private adviceCount = 0;
  private implSession: string | undefined;
  private lastPatch: PatchInfo | undefined;
  private lastReport: ImplementerReport | null = null;
  private clarifications: Clarification[] = [];
  private questionStops = 0;
  /** Own choices from every implementer report since the last checkpoint, by question. */
  private pendingChoices = new Map<string, OwnChoice>();
  /** Per round, so a correction after an overrule gets its own attempt number and log folder. */
  private nextAttempt = 0;
  /** What setup changed in the implementer's worktree; kept out of every patch while unchanged. */
  private setupState = new Map<string, string | null>();

  constructor(
    private readonly task: TaskSpec,
    private readonly o: EngineOptions,
  ) {
    this.observer = o.observer ?? (() => {});
    this.run_dir = join(o.paths.runs, this.run_id);
    this.wt_root = join(o.paths.worktrees, this.run_id);
    this.impl = join(this.wt_root, 'impl');
  }

  async execute(): Promise<RunSummary> {
    const { store } = this.o;
    const repo = this.task.repo.path_abs;

    // Everything that can fail on bad config or a missing CLI happens before any row is written.
    this.repoCfg = loadRepoConfig(repo);
    const roles = resolveRoles(this.o.global, this.repoCfg, this.task.routing);
    this.implementer = roles.implementer;
    this.reviewers = this.selectReviewers(roles.reviewers);
    this.providers = await prepareProviders(this.o.global, this.o.adapters, store, this.o.paths, [
      this.implementer.provider,
      ...this.reviewers.map((r) => r.target.provider),
    ]);
    this.base_sha = await revParse(repo, this.task.repo.base_ref ?? 'HEAD');
    this.branch = await currentBranch(repo);

    mkdirSync(this.run_dir, { recursive: true });
    if (!store.getTask(this.task.id)) store.insertTask(this.task, this.base_sha, this.branch);
    store.insertRun({ id: this.run_id, task_id: this.task.id, run_dir: this.run_dir, pid: process.pid });
    store.updateRun(this.run_id, { worktree_path: this.impl });
    writeFileSync(join(this.run_dir, 'task.json'), JSON.stringify(this.task, null, 2));
    this.observer({ type: 'run_started', run_id: this.run_id, task_id: this.task.id, title: this.task.title, base_sha: this.base_sha, run_dir: this.run_dir, worktree: this.impl });

    const wall = setTimeout(() => this.ac.abort('budget'), this.task.budget.max_wall_ms);
    const onExternalAbort = (): void => this.ac.abort('operator');
    if (this.o.signal?.aborted) onExternalAbort();
    else this.o.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const heartbeat = setInterval(() => store.updateRun(this.run_id, { heartbeat_at: new Date().toISOString() }), 15_000);

    this.dispatcher = new Dispatcher({
      store,
      providers: this.providers,
      loop: this.o.global.loop,
      max_worker_runs: this.task.budget.max_worker_runs,
      stop_file: this.o.paths.stopFile,
      observer: this.observer,
      signal: this.ac.signal,
    });

    let stop: Stop;
    let crashed: unknown;
    try {
      stop = await this.loop();
    } catch (e) {
      if (e instanceof BudgetExceeded) stop = { outcome: 'escalated', reason: 'budget', detail: e.message };
      else if (e instanceof DispatchPaused || this.ac.signal.aborted) stop = this.abortStop(e instanceof Error ? e.message : String(e));
      else {
        crashed = e;
        stop = { outcome: 'aborted', reason: 'unrecoverable', detail: e instanceof Error ? (e.stack ?? e.message) : String(e) };
      }
    } finally {
      clearTimeout(wall);
      clearInterval(heartbeat);
      this.o.signal?.removeEventListener('abort', onExternalAbort);
    }
    return this.finish(stop, crashed !== undefined);
  }

  private abortStop(detail: string): Stop {
    const budget = this.ac.signal.reason === 'budget';
    return { outcome: 'aborted', reason: budget ? 'budget' : 'operator', detail: budget ? `wall-clock budget of ${this.task.budget.max_wall_ms} ms exhausted` : detail || 'stopped by the operator' };
  }

  private selectReviewers(all: ResolvedTarget[]): { target: ResolvedTarget; same_vendor: boolean }[] {
    const policy = this.o.global.loop.require_cross_vendor_review;
    const out: { target: ResolvedTarget; same_vendor: boolean }[] = [];
    for (const target of all.slice(0, this.task.budget.max_reviewers)) {
      const same = target.provider === this.implementer.provider;
      if (same && policy === 'enforce') {
        this.observer({ type: 'warning', message: `skipping ${target.slot}: same provider as the implementer and require_cross_vendor_review is "enforce"` });
        continue;
      }
      if (same && policy === 'warn') this.observer({ type: 'warning', message: `${target.slot} uses the implementer's provider (${target.provider}); its verdicts are tagged same-vendor` });
      out.push({ target, same_vendor: same });
    }
    return out;
  }

  // ---- the loop --------------------------------------------------------------

  private async loop(): Promise<Stop> {
    const repo = this.task.repo.path_abs;
    this.observer({ type: 'phase', round: 0, phase: 'setup', detail: 'creating the implementer worktree' });
    ensureHooksDir(this.o.paths.hooks);
    await createWorktree({ repo_abs: repo, path_abs: this.impl, base_sha: this.base_sha, hooks_dir: this.o.paths.hooks });
    const setup = await setupWorktree({ repo_abs: repo, worktree_abs: this.impl, setup: this.repoCfg.setup, log_dir_abs: join(this.run_dir, 'setup'), signal: this.ac.signal });
    if (!setup.ok) return { outcome: 'aborted', reason: 'unrecoverable', detail: `worktree setup failed: ${setup.detail} (logs in ${join(this.run_dir, 'setup')})` };
    this.setupState = await worktreeState(this.impl, this.base_sha, join(this.run_dir, 'setup'));
    if (this.setupState.size) {
      const names = [...this.setupState.keys()];
      this.observer({ type: 'warning', message: `setup changed ${names.length} file(s) (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}); they stay out of the patch unless the implementer changes them` });
    }

    const baseline = await this.verifyBaseline();
    if (baseline) return baseline;

    const instructions = await loadInstructions(this.impl, this.repoCfg.instructions.sources, { repo_abs: this.task.repo.path_abs });
    for (const w of instructions.warnings) this.observer({ type: 'warning', message: `instructions: ${w.source}: ${w.message}` });
    this.baseStatic = {
      schema_version: 1,
      task: this.task,
      repo: { base_sha: this.base_sha, branch: this.branch, root_rel: '.', verification_summary: describePlan(buildPlan(this.repoCfg, this.task)) },
      instructions: instructions.docs,
      files: await loadExcerpts(this.impl, this.task.context_files),
    };

    if (this.task.clarify) {
      const stopped = await this.clarifyStep();
      if (stopped) return stopped;
    }

    let fixTargets: FixTarget[] = [];
    let prevDebt: number | undefined;

    for (this.round = 1; this.round <= this.task.budget.max_rounds; this.round++) {
      this.o.store.insertRound(this.run_id, this.round);
      this.nextAttempt = 0;
      let implemented = await this.implementUntilGreen(fixTargets);
      if ('stop' in implemented) return this.endRound(implemented.stop, implemented.debt);

      // The implementer's own judgment calls, shown before anyone reviews the code. Overrules go back to it as fixes.
      const overrules = await this.reviewChoices(true);
      if (overrules.length) {
        implemented = await this.implementUntilGreen(overrules);
        if ('stop' in implemented) return this.endRound(implemented.stop, implemented.debt);
        await this.reviewChoices(false);
      }

      if (this.task.gates.includes('after_implement')) {
        const a = await this.askGate('after_implement', `Round ${this.round}: verification is green. ${this.describePatch(implemented.patch)}`, []);
        if (a === 'abort') return this.endRound({ outcome: 'aborted', reason: 'operator', detail: 'aborted at the after_implement gate' }, zeroDebt());
      }

      // Green with every earlier reproduction in the plan: the findings that drove this round are fixed.
      for (const f of this.openFindings) this.o.store.resolveFinding(f.uid, this.round);
      this.openFindings = [];

      const review = await this.review(implemented.patch);
      const debt: Debt = { failing_required_steps: 0, confirmed_open_findings: review.confirmed.length, total: review.confirmed.length };
      this.openFindings = review.confirmed;
      this.needsHuman = review.needs_human;
      this.adviceCount += review.advice_count;

      if (this.reviewers.length > 0 && review.verdicts === 0) {
        return this.endRound({ outcome: 'escalated', reason: 'worker_failed', detail: 'verification is green, but no reviewer produced a valid verdict' }, debt);
      }

      if (review.needs_human.length > 0) {
        if (!this.o.gate) {
          return this.endRound({ outcome: 'escalated', reason: 'needs_human', detail: `${review.needs_human.length} finding(s) only the operator can judge` }, debt);
        }
        const a = await this.askGate('after_review', `Round ${this.round}: ${review.needs_human.length} finding(s) need your judgment. Continue = dismiss them.`, review.needs_human);
        if (a === 'abort') return this.endRound({ outcome: 'aborted', reason: 'operator', detail: 'aborted on findings that needed a human' }, debt);
        this.needsHuman = [];
      }

      if (review.confirmed.length === 0) return this.endRound({ outcome: 'converged', detail: this.reviewers.length ? 'verification green; no confirmed findings' : 'verification green; no reviewer configured' }, debt);

      if (this.round >= this.task.budget.max_rounds) {
        return this.endRound({ outcome: 'escalated', reason: 'budget', detail: `${review.confirmed.length} confirmed finding(s) open after the last allowed round (max_rounds = ${this.task.budget.max_rounds})` }, debt);
      }
      if (prevDebt !== undefined && debt.total >= prevDebt) {
        return this.endRound({ outcome: 'escalated', reason: 'no_progress', detail: `debt went from ${prevDebt} to ${debt.total}; a round must strictly reduce it` }, debt);
      }
      const regress = review.confirmed.find((f) => f.regression_of);
      if (regress) {
        return this.endRound({ outcome: 'escalated', reason: 'regression_loop', detail: `${regress.id} recurs an earlier defect (${regress.regression_of}): ${regress.claim}` }, debt);
      }

      if (this.task.gates.includes('after_review')) {
        const a = await this.askGate('after_review', `Round ${this.round}: ${review.confirmed.length} confirmed finding(s). Continue = send them back to the implementer.`, []);
        if (a === 'abort') return this.endRound({ outcome: 'aborted', reason: 'operator', detail: 'aborted at the after_review gate' }, debt);
      }

      fixTargets = review.confirmed.map(findingToTarget);
      prevDebt = debt.total;
      this.prior.push({
        round: this.round,
        verification: summarize(implemented.verification),
        confirmed_findings: review.confirmed,
        advice_count: review.advice_count,
        implementer_report_summary: this.lastReport?.summary ?? '',
      });
      this.finishRound(debt, { action: 'iterate', fix_targets: fixTargets });
    }
    return { outcome: 'escalated', reason: 'budget', detail: 'round budget exhausted' };
  }

  /**
   * "Green" only means something if the base commit is green. If the repo's
   * own checks already fail, an implementer ends up repairing (or gaming) the
   * checks instead of doing the task, so stop before any quota is spent.
   * Acceptance checks are excluded: they are expected to fail until the work is done.
   */
  private async verifyBaseline(): Promise<Stop | undefined> {
    if (this.o.skip_baseline || !this.o.global.loop.verify_baseline) return undefined;
    const plan = buildPlan(this.repoCfg, this.task).filter((s) => !s.source.startsWith('acceptance:'));
    if (!plan.length) return undefined;
    this.observer({ type: 'phase', round: 0, phase: 'verify', detail: 'baseline: the base commit must pass its own checks' });
    const result = await runVerification({
      run_id: this.run_id,
      round: 0,
      attempt: 0,
      worktree_abs: this.impl,
      base_sha: this.base_sha,
      patch_sha256: '',
      plan,
      log_dir_abs: join(this.run_dir, 'baseline'),
      signal: this.ac.signal,
      onStep: (step) => {
        this.o.store.insertVerificationStep(this.run_id, 0, 0, step);
        this.observer({ type: 'verification_step', round: 0, attempt: 0, step });
      },
    });
    if (this.ac.signal.aborted) throw new DispatchPaused('');
    if (result.passed) return undefined;
    const red = result.steps.filter((s) => !s.passed && s.required);
    return {
      outcome: 'aborted',
      reason: 'unrecoverable',
      detail: `verification is already red at the base commit (${red.map((s) => s.step_id).join(', ')}), before any change was made. Fix the check, or disable it for this task with verification.disable; no worker quota was spent. Logs: ${join(this.run_dir, 'baseline')}`,
    };
  }

  private endRound(stop: Stop, debt: Debt): Stop {
    const decision: LoopDecision =
      stop.outcome === 'converged'
        ? { action: 'converged' }
        : stop.outcome === 'aborted'
          ? { action: 'abort', reason: stop.reason, detail: stop.detail }
          : stop.reason === 'needs_human'
            ? { action: 'gate', gate: 'after_review', needs_human: this.needsHuman }
            : { action: 'escalate', reason: stop.reason, detail: stop.detail };
    this.finishRound(debt, decision);
    return stop;
  }

  private finishRound(debt: Debt, decision: LoopDecision): void {
    this.o.store.finishRound(this.run_id, this.round, debt, decision);
    this.observer({ type: 'decision', round: this.round, decision, debt });
  }

  private async askGate(gate: Gate, summary: string, needs_human: Finding[]): Promise<GateAnswer> {
    if (!this.o.gate) {
      this.observer({ type: 'warning', message: `gate ${gate} passed automatically (no interactive terminal)` });
      this.o.store.insertGateDecision(this.run_id, this.round, gate, 'auto_continue');
      return 'continue';
    }
    this.o.store.updateRun(this.run_id, { status: 'gated' });
    const answer = await this.o.gate({ gate, round: this.round, summary, needs_human });
    this.o.store.updateRun(this.run_id, { status: 'running' });
    this.o.store.insertGateDecision(this.run_id, this.round, gate, answer, needs_human.length ? { dismissed: needs_human.map((f) => f.uid) } : undefined);
    return answer;
  }

  // ---- implement + verify ----------------------------------------------------

  private roundDir(...parts: string[]): string {
    return join(this.run_dir, 'rounds', String(this.round), ...parts);
  }

  private packBase(): { base: PackBase; pack_id: string } {
    const base: PackBase = { ...this.baseStatic, prior: this.prior, decisions: this.decisions };
    return { base, pack_id: packId(base) };
  }

  private async implementUntilGreen(initialTargets: FixTarget[]): Promise<{ patch: PatchInfo; verification: VerificationResult } | { stop: Stop; debt: Debt }> {
    let fixTargets = initialTargets;
    const maxFix = this.task.budget.max_fix_attempts_per_round;
    const first = this.nextAttempt;

    for (let attempt = first; ; attempt++) {
      this.nextAttempt = attempt + 1;
      const fixes = attempt - first;
      const opening = fixTargets.every((t) => t.ref.startsWith('choice:')) && fixTargets.length ? `applying ${fixTargets.length} overruled choice(s)` : fixTargets.length ? `fixing ${fixTargets.length} confirmed finding(s)` : 'first pass';
      this.observer({ type: 'phase', round: this.round, phase: 'implement', detail: fixes === 0 ? opening : `fix attempt ${fixes} of ${maxFix}` });
      const { base, pack_id } = this.packBase();
      const rendered = renderPack({
        base,
        pack_id,
        run_id: this.run_id,
        round: this.round,
        addendum: { role: 'implementer', fix_targets: fixTargets },
        worktree_abs: this.impl,
        keep_dir_abs: this.roundDir(`implement-${attempt}`, 'pack'),
        asking: this.askingFor(),
        ...(this.templatesDir() ? { templates_dir_abs: this.templatesDir()! } : {}),
      });
      this.o.store.updateRun(this.run_id, { pack_id });

      const before = await snapshotGit(this.impl);
      let worked = await this.runRole<ImplementerReport>({
        run_id: this.run_id,
        round: this.round,
        role: 'implementer',
        attempt,
        purpose: fixTargets.length ? 'fix' : 'work',
        target: this.implementer,
        cwd_abs: this.impl,
        prompt: rendered.prompt,
        prompt_sha256: rendered.prompt_sha256,
        prompt_path_abs: rendered.prompt_path_abs,
        pack_id,
        policy: buildPolicy(this.repoCfg),
        log_root_abs: this.roundDir(`implement-${attempt}`),
        ...(this.implSession ? { resume_session: this.implSession } : {}),
      });
      if (this.ac.signal.aborted) throw new DispatchPaused('');
      const c = worked.last.result.classification;
      if (c !== 'ok') {
        return { stop: { outcome: 'escalated', reason: c === 'rate_limited' ? 'quota_exhausted' : 'worker_failed', detail: `implementer ${c}: ${worked.last.result.detail ?? 'no detail'} (logs: ${worked.last.log_dir_abs})` }, debt: unknownDebt() };
      }
      this.implSession = worked.last.result.session_ref ?? this.implSession;
      this.collectChoices(worked.output);

      // Blocking questions: the implementer stopped because a wrong guess would waste the work. Answer, resume, repeat.
      for (let n = 1; worked.output?.blocking_questions.length; n++) {
        const resumed = await this.answerBlocking(worked.output.blocking_questions, attempt, n, fixTargets);
        if (!resumed) break;
        worked = resumed;
        if (this.ac.signal.aborted) throw new DispatchPaused('');
        const rc = worked.last.result.classification;
        if (rc !== 'ok') {
          return { stop: { outcome: 'escalated', reason: rc === 'rate_limited' ? 'quota_exhausted' : 'worker_failed', detail: `implementer ${rc} after answering its questions: ${worked.last.result.detail ?? 'no detail'} (logs: ${worked.last.log_dir_abs})` }, debt: unknownDebt() };
        }
        this.implSession = worked.last.result.session_ref ?? this.implSession;
        this.collectChoices(worked.output);
      }
      this.lastReport = worked.output ?? null;
      if (!worked.output) this.observer({ type: 'warning', message: `implementer produced no valid report (${(worked.errors ?? []).slice(0, 3).join('; ')}); continuing with the patch alone` });

      // A harvested reproduction is part of the definition of done. Editing it is not a fix.
      for (const h of this.harvested) {
        const tampered = restoreHarvested(this.impl, h.keep_dir, h.files);
        if (tampered.length) this.observer({ type: 'warning', message: `implementer modified reproduction file(s) ${tampered.join(', ')}; restored the originals` });
      }

      const patch = await extractPatch({ worktree_abs: this.impl, base_sha: this.base_sha, patch_path_abs: this.roundDir(`implement-${attempt}.patch`), touch_hint: this.task.touch_hint, setup_state: this.setupState });
      const audit = await auditWorktree(this.impl, this.base_sha, before);
      const fatal = audit.filter((v) => v.severity === 'fatal');
      this.o.store.annotateWorkerRun(worked.last.worker_run_id, { patch, audit, ...(fatal.length ? { classification: 'git_mutated', detail: fatal.map((v) => v.detail).join('; ') } : {}) });
      this.observer({ type: 'patch', round: this.round, attempt, patch });
      if (fatal.length) {
        return { stop: { outcome: 'escalated', reason: 'git_mutated', detail: `the implementer changed git state: ${fatal.map((v) => v.detail).join('; ')}. The worktree is kept for inspection; its diff is at ${patch.path_abs}` }, debt: unknownDebt() };
      }
      if (patch.deleted.length) this.observer({ type: 'warning', message: `the patch deletes ${patch.deleted.join(', ')}` });
      if (patch.files_changed.length > 20 && patch.outside_touch_hint.length > 0 && this.task.touch_hint.length > 0) {
        this.observer({ type: 'warning', message: `scope: ${patch.files_changed.length} files changed, ${patch.outside_touch_hint.length} outside touch_hint` });
      }

      const unchanged = this.lastPatch !== undefined && this.lastPatch.sha256 === patch.sha256;
      const claimsDone = !!worked.output && worked.output.acceptance.length > 0 && worked.output.acceptance.every((a) => a.status === 'done' || a.status === 'not_applicable');
      if ((patch.empty && !claimsDone) || (unchanged && fixTargets.length > 0)) {
        const why = patch.empty ? 'the implementer changed no files' : 'the patch is identical to the previous attempt';
        if (fixes >= maxFix) return { stop: { outcome: 'escalated', reason: 'empty_diff', detail: why }, debt: unknownDebt() };
        this.observer({ type: 'warning', message: `${why}; asking once more` });
        fixTargets = [...fixTargets.filter((t) => t.ref !== 'empty_diff'), { kind: 'operator', ref: 'empty_diff', summary: 'Your last turn left the working tree unchanged', detail: `${why}. The task is not done. Make the change in the working tree, then write your report.` }];
        this.lastPatch = patch;
        continue;
      }
      this.lastPatch = patch;

      this.observer({ type: 'phase', round: this.round, phase: 'verify' });
      const verification = await runVerification({
        run_id: this.run_id,
        round: this.round,
        attempt,
        worktree_abs: this.impl,
        base_sha: this.base_sha,
        patch_sha256: patch.sha256,
        plan: buildPlan(this.repoCfg, this.task, this.harvestedSteps),
        log_dir_abs: this.roundDir(`verify-${attempt}`),
        signal: this.ac.signal,
        onStep: (step) => {
          this.o.store.insertVerificationStep(this.run_id, this.round, attempt, step);
          this.observer({ type: 'verification_step', round: this.round, attempt, step });
        },
      });
      if (this.ac.signal.aborted) throw new DispatchPaused('');
      if (verification.passed) return { patch, verification };

      const summary = summarize(verification);
      const debt: Debt = { failing_required_steps: summary.failed_steps.length, confirmed_open_findings: this.openFindings.length, total: summary.failed_steps.length + this.openFindings.length };
      if (fixes >= maxFix) {
        return { stop: { outcome: 'escalated', reason: 'verification_stuck', detail: `verification still red after ${fixes} fix attempt(s): ${summary.failed_steps.map((s) => s.step_id).join(', ')}` }, debt };
      }
      fixTargets = summary.failed_steps.map((s) => ({
        kind: 'verification_failure' as const,
        ref: s.step_id,
        summary: `Check \`${s.step_id}\` fails (\`${s.command}\`)`,
        detail: [
          ...s.failures.slice(0, 15).map((f) => `- ${f.name}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}: ${f.message.split('\n')[0]}`),
          '',
          'Log tail:',
          '```',
          s.tail,
          '```',
        ].join('\n'),
      }));
    }
  }

  /**
   * One read-only turn in the implementer's own session: what would it ask
   * before writing code? Answers become binding decisions in every later pack,
   * so the reviewer checks the work against the operator's answer rather than
   * the implementer's guess. The implementer then resumes the same session.
   * A failed clarify turn never fails the run; the implementer just starts fresh.
   */
  private async clarifyStep(): Promise<Stop | undefined> {
    this.observer({ type: 'phase', round: 0, phase: 'clarify', detail: 'the implementer lists what it would ask you before it writes code' });
    const dir = join(this.run_dir, 'clarify');
    const { base, pack_id } = this.packBase();
    const rendered = renderPack({
      base,
      pack_id,
      run_id: this.run_id,
      round: 0,
      addendum: { role: 'implementer', fix_targets: [] },
      worktree_abs: this.impl,
      keep_dir_abs: join(dir, 'pack'),
      template: 'clarify',
      output_kind: 'questions',
      ...(this.templatesDir() ? { templates_dir_abs: this.templatesDir()! } : {}),
    });
    const before = await snapshotGit(this.impl);
    const worked = await this.runRole<QuestionsOutput>({
      run_id: this.run_id,
      round: 0,
      role: 'implementer',
      output_kind: 'questions',
      attempt: 0,
      purpose: 'clarify',
      target: this.implementer,
      cwd_abs: this.impl,
      prompt: rendered.prompt,
      prompt_sha256: rendered.prompt_sha256,
      prompt_path_abs: rendered.prompt_path_abs,
      pack_id,
      policy: { ...buildPolicy(this.repoCfg), fs: 'read-only' },
      log_root_abs: dir,
    });
    if (this.ac.signal.aborted) throw new DispatchPaused('');

    const fatal = (await auditWorktree(this.impl, this.base_sha, before)).filter((v) => v.severity === 'fatal');
    if (fatal.length) {
      this.o.store.annotateWorkerRun(worked.last.worker_run_id, { classification: 'git_mutated', detail: fatal.map((v) => v.detail).join('; ') });
      return { outcome: 'escalated', reason: 'git_mutated', detail: `the implementer changed git state during its read-only clarify turn: ${fatal.map((v) => v.detail).join('; ')}` };
    }
    const c = worked.last.result.classification;
    if (c !== 'ok' || !worked.output) {
      this.observer({ type: 'warning', message: `clarify turn ${c !== 'ok' ? c : `gave no valid questions (${(worked.errors ?? []).slice(0, 2).join('; ')})`}; continuing without it` });
      return undefined;
    }
    this.implSession = worked.last.result.session_ref ?? this.implSession;

    let questions = worked.output.questions;
    if (questions.length > MAX_QUESTIONS) {
      this.observer({ type: 'warning', message: `the implementer asked ${questions.length} questions; keeping the first ${MAX_QUESTIONS}. A long list usually means the task needs rewriting.` });
      questions = questions.slice(0, MAX_QUESTIONS);
    }
    if (!questions.length) {
      this.observer({ type: 'clarified', clarifications: [] });
      return undefined;
    }

    await this.askQuestions('before_coding', questions);
    return undefined;
  }

  // ---- asking the operator ------------------------------------------------------

  private askingFor(): { attended: boolean; stops_left: number } {
    return { attended: !!this.o.questions, stops_left: Math.max(0, this.o.global.loop.max_question_stops - this.questionStops) };
  }

  /**
   * Wait for the operator, but never forever: after answer_timeout_ms the
   * implementer's recommendation stands, so a run left alone still finishes.
   */
  private async waitForOperator<T>(ask: (signal: AbortSignal) => Promise<T>, fallback: T): Promise<{ value: T; answered: boolean }> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.o.global.loop.answer_timeout_ms);
    const onAbort = (): void => timeout.abort();
    this.ac.signal.addEventListener('abort', onAbort, { once: true });
    const expired = new Promise<typeof EXPIRED>((resolve) => timeout.signal.addEventListener('abort', () => resolve(EXPIRED), { once: true }));
    this.o.store.updateRun(this.run_id, { status: 'gated' });
    try {
      const result = await Promise.race([ask(timeout.signal), expired]);
      if (this.ac.signal.aborted) throw new DispatchPaused('');
      if (result === EXPIRED) {
        this.observer({ type: 'warning', message: `no answer within ${Math.round(this.o.global.loop.answer_timeout_ms / 60_000)} min; going with the implementer's recommendation` });
        return { value: fallback, answered: false };
      }
      return { value: result, answered: true };
    } finally {
      clearTimeout(timer);
      this.ac.signal.removeEventListener('abort', onAbort);
      this.o.store.updateRun(this.run_id, { status: 'running' });
    }
  }

  /** Ask (or, with nobody there, take the recommendations), then record every answer as a binding decision. */
  private async askQuestions(stage: 'before_coding' | 'blocking', asked: Question[], opts: { operator: boolean } = { operator: true }): Promise<Clarification[]> {
    let questions = asked;
    if (questions.length > MAX_QUESTIONS) {
      this.observer({ type: 'warning', message: `the implementer asked ${questions.length} questions; keeping the first ${MAX_QUESTIONS}. A long list usually means the task needs rewriting.` });
      questions = questions.slice(0, MAX_QUESTIONS);
    }
    const handler = opts.operator ? this.o.questions : undefined;
    const res = handler ? await this.waitForOperator((signal) => handler({ stage, questions, signal }), {} as Record<string, string>) : { value: {}, answered: false };
    const source: Clarification['source'] = res.answered ? 'operator' : 'default';
    const added = questions.map((q) => ({ id: q.id, stage, question: q.question, answer: res.value[q.id]?.trim() || q.default, source }));
    this.record(added, stage === 'before_coding' ? 'clarify' : 'blocking', source === 'operator' ? 'answered' : 'defaults', { questions });
    return added;
  }

  private record(added: Clarification[], gate: string, action: string, payload: object): void {
    for (const cl of added) this.decisions.push(decisionText(cl));
    this.clarifications.push(...added);
    this.o.store.insertGateDecision(this.run_id, this.round, gate, action, { ...payload, clarifications: added });
    writeFileSync(join(this.run_dir, 'clarifications.json'), JSON.stringify(this.clarifications, null, 2));
    this.observer({ type: 'clarified', clarifications: added });
  }

  /** The implementer stopped mid-work. Answer its questions and resume the same session where it stopped. */
  private async answerBlocking(questions: Question[], attempt: number, n: number, fixTargets: FixTarget[]): Promise<{ last: DispatchOutcome; output?: ImplementerReport; errors?: string[] } | undefined> {
    this.questionStops++;
    const allowed = this.o.global.loop.max_question_stops;
    if (this.questionStops > allowed + 1) {
      this.observer({ type: 'warning', message: `the implementer keeps stopping after being told it cannot; continuing with what is in the tree` });
      return undefined;
    }
    // Past its allowance it was told it cannot stop; do not interrupt the operator for it, take its recommendations.
    const withinAllowance = this.questionStops <= allowed;
    this.observer({
      type: 'phase',
      round: this.round,
      phase: 'implement',
      detail: withinAllowance ? `the implementer stopped to ask ${questions.length} question(s) (stop ${this.questionStops} of ${allowed})` : 'the implementer stopped again after its last allowed stop; taking its recommendations',
    });
    const answered = await this.askQuestions('blocking', questions, { operator: withinAllowance });
    if (this.ac.signal.aborted) throw new DispatchPaused('');
    if (!this.dispatcher.canSpawn()) throw new BudgetExceeded(this.task.budget.max_worker_runs);

    const { base, pack_id } = this.packBase();
    const rendered = renderPack({
      base,
      pack_id,
      run_id: this.run_id,
      round: this.round,
      addendum: { role: 'implementer', fix_targets: fixTargets },
      worktree_abs: this.impl,
      keep_dir_abs: this.roundDir(`implement-${attempt}`, `pack-answer-${n}`),
      asking: this.askingFor(),
      ...(this.templatesDir() ? { templates_dir_abs: this.templatesDir()! } : {}),
    });
    const resumable = !!this.implSession && this.providers.get(this.implementer.provider)!.caps.resume;
    const list = answered.map((a) => `- ${a.question} → ${a.answer}`).join('\n');
    const prompt = resumable
      ? [
          'Your questions have been answered. These are now binding decisions, also listed in `.conductor/pack/CONTEXT.md`:',
          '',
          list,
          '',
          'Continue the task from where you stopped; your earlier work is still in the tree.',
          '',
          askingSection(this.askingFor()),
          '',
          'When you are done, write `.conductor/out/report.json` again, as described in your original instructions.',
        ].join('\n')
      : `You already started this task in this working tree and stopped to ask questions. The answers are binding decisions, listed in CONTEXT.md:\n\n${list}\n\nContinue from the current state of the tree.\n\n---\n\n${rendered.prompt}`;
    const promptPath = join(this.roundDir(`implement-${attempt}`), `ANSWER-PROMPT-${n}.md`);
    writeFileSync(promptPath, prompt);
    return this.runRole<ImplementerReport>({
      run_id: this.run_id,
      round: this.round,
      role: 'implementer',
      attempt,
      purpose: 'answer',
      target: this.implementer,
      cwd_abs: this.impl,
      prompt,
      prompt_sha256: sha256(prompt),
      prompt_path_abs: promptPath,
      pack_id,
      policy: buildPolicy(this.repoCfg),
      log_root_abs: this.roundDir(`implement-${attempt}`),
      ...(resumable ? { resume_session: this.implSession! } : {}),
    });
  }

  /**
   * The implementer's own judgment calls since the last checkpoint. With an
   * operator (and `interactive`), they are shown in one batch before review and
   * overrules come back as fixes; otherwise they are recorded as unconfirmed.
   */
  private collectChoices(report: ImplementerReport | undefined): void {
    const reviewed = new Set(this.clarifications.map((c) => c.question.trim().toLowerCase()));
    for (const d of report?.decisions_made ?? []) {
      const key = d.question.trim().toLowerCase();
      if (!reviewed.has(key)) this.pendingChoices.set(key, d);
    }
  }

  private async reviewChoices(interactive: boolean): Promise<FixTarget[]> {
    const choices = [...this.pendingChoices.values()];
    this.pendingChoices.clear();
    if (!choices.length) return [];

    const handler = interactive ? this.o.choices : undefined;
    const res = handler ? await this.waitForOperator((signal) => handler({ choices, signal }), {} as Record<string, string>) : { value: {}, answered: false };
    const targets: FixTarget[] = [];
    const added: Clarification[] = choices.map((d) => {
      const answer = res.value[d.id]?.trim();
      if (!answer || answer === d.chosen) return { id: d.id, stage: 'own_choice' as ClarificationStage, question: d.question, answer: d.chosen, source: res.answered ? 'operator' : 'default' };
      targets.push({
        kind: 'operator',
        ref: `choice:${d.id}`,
        summary: `The operator overruled your choice: ${d.question}`,
        detail: `You chose: ${d.chosen}\nThe operator decided: ${answer}\nChange the code to follow the operator's decision. It is binding.`,
      });
      return { id: d.id, stage: 'own_choice' as ClarificationStage, question: d.question, answer, source: 'operator', overruled_from: d.chosen };
    });
    this.record(added, 'choices', targets.length ? 'overruled' : res.answered ? 'accepted' : 'unreviewed', { choices });
    return targets;
  }

  private templatesDir(): string | undefined {
    return this.repoCfg.templates ? join(this.task.repo.path_abs, this.repoCfg.templates) : undefined;
  }

  /** Dispatch, then read the role's output file; one repair turn if it is missing or invalid. */
  private async runRole<T>(req: DispatchRequest): Promise<{ last: DispatchOutcome; output?: T; errors?: string[] }> {
    const first = await this.dispatcher.dispatch(req);
    if (first.result.classification !== 'ok') return { last: first };
    const kind = req.output_kind ?? req.role;
    const parsed = readRoleOutput<T>(req.cwd_abs, kind, first.result.final_text);
    this.o.store.annotateWorkerRun(first.worker_run_id, { output_valid: parsed.ok });
    if (parsed.ok) {
      // Keep every worker's document with its logs: the worktree's copy is overwritten by the next step.
      writeFileSync(join(first.log_dir_abs, 'output.json'), JSON.stringify(parsed.value, null, 2));
      return { last: first, output: parsed.value };
    }
    if (!this.dispatcher.canSpawn() || this.ac.signal.aborted) return { last: first, errors: parsed.errors };

    this.observer({ type: 'warning', message: `${req.role} output invalid (${parsed.errors.slice(0, 2).join('; ')}); running one repair turn` });
    const resumable = !!first.result.session_ref && first.provider.caps.resume;
    const prompt = repairPrompt(kind, parsed.errors, parsed.raw, resumable ? undefined : req.prompt);
    const promptPath = join(first.log_dir_abs, 'REPAIR-PROMPT.md');
    writeFileSync(promptPath, prompt);
    const { resume_session: _previous, ...rest } = req;
    const second = await this.dispatcher.dispatch({
      ...rest,
      purpose: 'repair',
      prompt,
      prompt_sha256: sha256(prompt),
      prompt_path_abs: promptPath,
      ...(resumable ? { resume_session: first.result.session_ref! } : {}),
    });
    if (second.result.classification !== 'ok') return { last: first, errors: parsed.errors };
    const reparsed = readRoleOutput<T>(req.cwd_abs, kind, second.result.final_text);
    this.o.store.annotateWorkerRun(second.worker_run_id, { output_valid: reparsed.ok });
    if (reparsed.ok) writeFileSync(join(second.log_dir_abs, 'output.json'), JSON.stringify(reparsed.value, null, 2));
    const last: DispatchOutcome = { ...second, result: { ...second.result, session_ref: second.result.session_ref ?? first.result.session_ref } };
    return reparsed.ok ? { last, output: reparsed.value } : { last, errors: reparsed.errors };
  }

  // ---- review + confirm ------------------------------------------------------

  private async review(patch: PatchInfo): Promise<{ confirmed: Finding[]; needs_human: Finding[]; advice_count: number; verdicts: number }> {
    if (!this.reviewers.length) return { confirmed: [], needs_human: [], advice_count: 0, verdicts: 0 };
    this.observer({ type: 'phase', round: this.round, phase: 'review', detail: `${this.reviewers.length} reviewer(s)` });
    const repo = this.task.repo.path_abs;
    const { base, pack_id } = this.packBase();

    // Reviewers run in parallel, each in its own throwaway worktree.
    const reviewed = await Promise.all(
      this.reviewers.map(async ({ target, same_vendor }, k) => {
        const wt = join(this.wt_root, `review-${this.round}-${k + 1}`);
        const name = `review-${k + 1}`;
        await createWorktree({ repo_abs: repo, path_abs: wt, base_sha: this.base_sha, hooks_dir: this.o.paths.hooks });
        await applyPatch(wt, patch.path_abs);
        const setup = await setupWorktree({ repo_abs: repo, worktree_abs: wt, setup: this.repoCfg.setup, log_dir_abs: this.roundDir(name, 'setup'), signal: this.ac.signal });
        if (!setup.ok) this.observer({ type: 'warning', message: `${target.slot}: worktree setup failed (${setup.detail}); the reviewer may be unable to run reproductions` });
        const rendered = renderPack({
          base,
          pack_id,
          run_id: this.run_id,
          round: this.round,
          addendum: { role: 'reviewer', diff_path: 'DIFF.patch', report_path: 'REPORT.json', repro_allowed_paths: this.repoCfg.repro.allowed_paths },
          worktree_abs: wt,
          keep_dir_abs: this.roundDir(name, 'pack'),
          diff_path_abs: patch.path_abs,
          report: this.lastReport,
          ...(this.templatesDir() ? { templates_dir_abs: this.templatesDir()! } : {}),
        });
        const before = await snapshotGit(wt);
        const worked = await this.runRole<VerdictOutput>({
          run_id: this.run_id,
          round: this.round,
          role: 'reviewer' as Role,
          attempt: 0,
          purpose: 'work',
          target,
          cwd_abs: wt,
          prompt: rendered.prompt,
          prompt_sha256: rendered.prompt_sha256,
          prompt_path_abs: rendered.prompt_path_abs,
          pack_id,
          policy: buildPolicy(this.repoCfg),
          log_root_abs: this.roundDir(name),
          same_vendor_review: same_vendor,
        });
        const audit = await auditWorktree(wt, this.base_sha, before);
        const fatal = audit.filter((v) => v.severity === 'fatal');
        this.o.store.annotateWorkerRun(worked.last.worker_run_id, { audit, ...(fatal.length ? { classification: 'git_mutated', detail: fatal.map((v) => v.detail).join('; ') } : {}) });
        if (fatal.length) this.observer({ type: 'warning', message: `${target.slot} changed git state in its throwaway worktree: ${fatal.map((v) => v.detail).join('; ')}` });
        return { target, same_vendor, wt, name, worked };
      }),
    );
    if (this.ac.signal.aborted) throw new DispatchPaused('');

    // Confirmation runs in the implementer's tree, so it is strictly one at a time.
    this.observer({ type: 'phase', round: this.round, phase: 'confirm' });
    const confirmed: Finding[] = [];
    const needs_human: Finding[] = [];
    let advice_count = 0;
    let verdicts = 0;
    try {
      for (const r of reviewed) {
        const c = r.worked.last.result.classification;
        if (c !== 'ok' || !r.worked.output) {
          this.observer({ type: 'warning', message: `${r.target.slot} produced no verdict (${c !== 'ok' ? c : (r.worked.errors ?? []).slice(0, 2).join('; ')})` });
        } else {
          verdicts++;
          const out = r.worked.output;
          const outcome = await confirmFindings({
            findings: out.findings,
            task: this.task,
            repo: this.repoCfg,
            impl_worktree_abs: this.impl,
            reviewer_worktree_abs: r.wt,
            implementer_changed: patch.files_changed,
            harvest_dir_abs: join(this.run_dir, 'harvest'),
            log_dir_abs: this.roundDir('confirm'),
            signal: this.ac.signal,
          });
          const verdict: Verdict = {
            ...out,
            findings: outcome.findings,
            run_id: this.run_id,
            round: this.round,
            reviewer: { provider: r.target.provider, model_label: r.target.model, model_id: r.target.model_id, worker_run_id: r.worked.last.worker_run_id, same_vendor: r.same_vendor },
          };
          this.o.store.insertVerdict(verdict);
          writeFileSync(this.roundDir(r.name, 'verdict.json'), JSON.stringify(verdict, null, 2));
          for (const f of outcome.findings) {
            this.observer({ type: 'finding', round: this.round, finding: f });
            if (f.confirmation.status === 'needs_human') needs_human.push(f);
            else if (!f.is_advice) {
              confirmed.push(f);
              if (f.confirmation.harvested_files?.length) this.harvested.push({ finding_uid: f.uid, files: f.confirmation.harvested_files, keep_dir: join(this.run_dir, 'harvest', f.uid) });
            }
          }
          this.harvestedSteps.push(...outcome.new_steps);
          advice_count += out.advice.length + outcome.findings.filter((f) => f.is_advice).length;
        }
      }
    } finally {
      for (const r of reviewed) await removeWorktree(repo, r.wt);
    }
    return { confirmed, needs_human, advice_count, verdicts };
  }

  // ---- finish ----------------------------------------------------------------

  private describePatch(p: PatchInfo): string {
    return `${p.files_changed.length} file(s), +${p.insertions} −${p.deletions}`;
  }

  private async finish(stop: Stop, crashed: boolean): Promise<RunSummary> {
    const { store } = this.o;
    const openRepro = this.harvested.filter((h) => this.openFindings.some((f) => f.uid === h.finding_uid)).flatMap((h) => h.files);
    let patch: PatchInfo | undefined;
    try {
      // Reproductions of still-open findings fail by definition; they stay out of the deliverable.
      patch = await extractPatch({ worktree_abs: this.impl, base_sha: this.base_sha, patch_path_abs: join(this.run_dir, 'result.patch'), touch_hint: this.task.touch_hint, exclude_paths: openRepro, setup_state: this.setupState });
    } catch {
      /* the worktree may not exist if setup never got that far */
    }
    const outcome: RunOutcome = crashed ? 'crashed' : stop.outcome;
    const status: RunStatus = outcome === 'converged' ? 'done' : outcome;
    const reason = stop.outcome === 'escalated' ? stop.reason : undefined;
    store.updateRun(this.run_id, {
      ended_at: new Date().toISOString(),
      status,
      outcome,
      escalation_reason: reason ?? (stop.outcome === 'aborted' ? stop.reason : null),
      detail: stop.detail,
      wall_ms: Date.now() - this.started,
      ...(patch ? { patch_path: patch.path_abs, patch_sha256: patch.sha256 } : {}),
    });
    store.setTaskStatus(this.task.id, status);

    const summary: RunSummary = {
      run_id: this.run_id,
      task_id: this.task.id,
      outcome,
      status,
      ...(reason ? { escalation_reason: reason } : {}),
      detail: stop.detail,
      run_dir: this.run_dir,
      worktree: this.impl,
      ...(patch ? { patch_path: patch.path_abs, patch } : {}),
      rounds: Math.min(this.round, this.task.budget.max_rounds),
      worker_runs: this.dispatcher.workerRunsUsed,
      open_findings: this.openFindings,
      needs_human: this.needsHuman,
      advice_count: this.adviceCount,
      open_repro_files: openRepro,
      clarifications: this.clarifications,
      open_questions: this.lastReport?.open_questions ?? [],
      did_not_do: this.lastReport?.did_not_do ?? [],
    };
    writeFileSync(join(this.run_dir, 'summary.json'), JSON.stringify(summary, null, 2));
    this.observer({ type: 'run_finished', run_id: this.run_id, outcome, detail: stop.detail, ...(patch ? { patch_path: patch.path_abs } : {}), worktree: this.impl });
    return summary;
  }
}

const EXPIRED = Symbol('expired');

/** How an answer reads in every later pack. Unconfirmed ones say so, so the reviewer knows it may challenge them. */
function decisionText(c: Clarification): string {
  if (c.overruled_from !== undefined) return `${c.question} → ${c.answer} (the operator decided, replacing the implementer's choice "${c.overruled_from}")`;
  if (c.source === 'default') {
    return `${c.question} → ${c.answer} (${c.stage === 'own_choice' ? "the implementer's own choice" : "the implementer's own recommendation"}; nobody confirmed it)`;
  }
  return `${c.question} → ${c.answer} (${c.stage === 'own_choice' ? "the implementer's choice, accepted by the operator" : 'the operator decided'})`;
}

const zeroDebt = (): Debt => ({ failing_required_steps: 0, confirmed_open_findings: 0, total: 0 });
/** The round stopped before verification could say anything. */
const unknownDebt = (): Debt => ({ failing_required_steps: -1, confirmed_open_findings: -1, total: -1 });

function findingToTarget(f: Finding): FixTarget {
  return {
    kind: 'confirmed_finding',
    ref: f.uid,
    summary: `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.claim}`,
    detail: [`Evidence: ${f.evidence || '(none given)'}`, `Confirmed by the orchestrator: ${f.confirmation.note}`, ...(f.suggested_fix ? [`Reviewer's hint (not an instruction): ${f.suggested_fix}`] : [])].join('\n'),
    reproduction: f.reproduction,
  };
}

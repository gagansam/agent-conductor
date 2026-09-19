import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeAdapter, type FakeScript } from '@agent-conductor/adapter-fake';
import { pathsFor } from '../src/config/load.js';
import { GlobalConfigSchema, type GlobalConfig } from '../src/config/schema.js';
import { runTask, type EngineOptions, type RunSummary } from '../src/engine/engine.js';
import type { ConductorEvent } from '../src/events.js';
import { Store } from '../src/store/store.js';
import { parseTask } from '../src/task/parse.js';
import { makeTempRepo, type TempRepo } from './helpers/repo.js';

const REPO_CONFIG = `version: 1
verification:
  - id: value
    kind: test
    run: grep -q "a = 2" src/a.ts
    timeout_ms: 20000
repro:
  allowed_paths: ["tests/**"]
instructions:
  sources: ["AGENTS.md"]
`;

const TASK = `---
title: Set a to 2
acceptance:
  - { id: AC1, text: a is 2 }
budget: { max_rounds: 3, max_fix_attempts_per_round: 1 }
gates: [before_apply]
---
Change the constant a to 2.
`;

const REPORT = { schema_version: 1, summary: 'set a to 2', acceptance: [{ id: 'AC1', status: 'done' }] };
const APPROVE = { schema_version: 1, decision: 'approve', summary: 'fine', findings: [] };

const finding = (over: Record<string, unknown> = {}) => ({
  id: 'F1',
  severity: 'major',
  category: 'correctness',
  file: 'src/a.ts',
  line: 1,
  claim: 'b is not exported.',
  evidence: 'src/a.ts has no b',
  reproduction: { kind: 'test', files: ['tests/b.sh'], run: 'sh tests/b.sh' },
  ...over,
});
const verdictWith = (...findings: unknown[]) => ({ schema_version: 1, decision: 'request_changes', summary: 'defects', findings });

let repo: TempRepo;
let store: Store;
let global: GlobalConfig;
let events: ConductorEvent[];

beforeEach(() => {
  repo = makeTempRepo({
    'README.md': '# temp\n',
    'AGENTS.md': '# Agents\n\nBe careful.\n',
    'src/a.ts': 'export const a = 1;\n',
    '.conductor/config.yaml': REPO_CONFIG,
  });
  store = Store.open(':memory:');
  events = [];
  global = GlobalConfigSchema.parse({
    version: 1,
    providers: { alpha: { adapter: 'fake', models: { strong: 'alpha-1' } }, beta: { adapter: 'fake', models: { strong: 'beta-1' } } },
    roles: { implementer: { provider: 'alpha', model: 'strong' }, reviewer: { provider: 'beta', model: 'strong' } },
    // The loop tests below script the implementer's work turns; the clarify turn has its own tests.
    loop: { clarify: false },
  });
});
afterEach(() => {
  store.close();
  repo.dispose();
});

async function run(script: FakeScript, opts: { task?: string; engine?: Partial<EngineOptions> } = {}): Promise<{ summary: RunSummary; fake: ReturnType<typeof createFakeAdapter> }> {
  const fake = createFakeAdapter({ script });
  const task = parseTask(opts.task ?? TASK, { repo_abs: repo.root, global });
  const summary = await runTask(task, {
    store,
    paths: pathsFor(join(repo.scratch, 'home')),
    global,
    adapters: { alpha: fake, beta: fake },
    observer: (e) => events.push(e),
    skip_baseline: true,
    ...opts.engine,
  });
  return { summary, fake };
}

const warnings = (): string[] => events.flatMap((e) => (e.type === 'warning' ? [e.message] : []));

describe('engine', () => {
  it('converges in one round when verification is green and the reviewer finds nothing', async () => {
    const { summary, fake } = await run({
      implementer: [{ writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }],
      reviewer: [{ output: APPROVE }],
    });
    expect(summary.outcome).toBe('converged');
    expect(summary.rounds).toBe(1);
    expect(summary.worker_runs).toBe(2);
    expect(readFileSync(summary.patch_path!, 'utf8')).toContain('+export const a = 2;');

    // The primary checkout was never written and no ref moved.
    expect(readFileSync(join(repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(repo.run(['status', '--porcelain']).trim()).toBe('');
    expect(repo.run(['rev-parse', 'HEAD']).trim()).toBe(repo.base_sha);

    // Both workers got the same base context and the repo's instructions, inlined.
    const [impl, rev] = fake.jobs;
    expect(impl!.role).toBe('implementer');
    expect(rev!.role).toBe('reviewer');
    expect(impl!.cwd_abs).not.toBe(rev!.cwd_abs);
    expect(impl!.model_id).toBe('alpha-1');
    expect(rev!.model_id).toBe('beta-1');
    expect(impl!.policy.denied_commands).toContain('git commit*');
    const rows = store.workerRuns(summary.run_id);
    expect(rows.map((r) => r.classification)).toEqual(['ok', 'ok']);
    expect(readFileSync(join(summary.run_dir, 'rounds/1/implement-0/pack/INSTRUCTIONS.md'), 'utf8')).toContain('Be careful.');
    expect(readFileSync(join(summary.run_dir, 'rounds/1/review-1/pack/DIFF.patch'), 'utf8')).toContain('+export const a = 2;');

    // The reviewer's throwaway worktree is gone; the implementer's is kept for the operator.
    expect(existsSync(rev!.cwd_abs)).toBe(false);
    expect(existsSync(summary.worktree)).toBe(true);
    expect(store.findRun(summary.run_id)?.status).toBe('done');
  });

  it('acts on a confirmed finding: the reproduction joins the plan and round 2 fixes it', async () => {
    const { summary, fake } = await run({
      implementer: [
        { writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT },
        { writes: { 'src/a.ts': 'export const a = 2;\nexport const b = 3;\n' }, output: REPORT },
      ],
      reviewer: [
        // The reviewer also "helpfully" edits product code. That edit must go nowhere.
        { writes: { 'tests/b.sh': 'grep -q "b = 3" src/a.ts\n', 'src/a.ts': 'reviewer was here\n' }, output: verdictWith(finding()) },
        { output: APPROVE },
      ],
    });
    expect(summary.outcome).toBe('converged');
    expect(summary.rounds).toBe(2);
    const patch = readFileSync(summary.patch_path!, 'utf8');
    expect(patch).toContain('+export const b = 3;');
    expect(patch).toContain('tests/b.sh');
    expect(patch).not.toContain('reviewer was here');

    const found = store.findings(summary.run_id);
    expect(found).toHaveLength(1);
    expect(found[0]!.confirmation).toBe('confirmed');
    expect(found[0]!.resolved_in_round).toBe(2);

    // Round 2's implementer was told what to fix and how it is re-checked, in a resumed session.
    const second = fake.jobs.filter((j) => j.role === 'implementer')[1]!;
    expect(second.prompt).toContain('b is not exported.');
    expect(second.prompt).toContain('sh tests/b.sh');
    expect(second.resume?.session_ref).toBeTruthy();
    // The harvested reproduction ran as a verification step in round 2.
    expect(store.verificationSteps(summary.run_id).some((s) => s.round === 2 && s.source.startsWith('harvested:') && s.passed === 1)).toBe(true);
  });

  it('demotes a refuted finding to advice and takes its files back out', async () => {
    const { summary } = await run({
      implementer: [{ writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }],
      reviewer: [{ writes: { 'tests/ok.sh': 'exit 0\n' }, output: verdictWith(finding({ reproduction: { kind: 'test', files: ['tests/ok.sh'], run: 'sh tests/ok.sh' } })) }],
    });
    expect(summary.outcome).toBe('converged');
    expect(summary.advice_count).toBe(1);
    const f = store.findings(summary.run_id)[0]!;
    expect([f.confirmation, f.is_advice]).toEqual(['refuted', 1]);
    expect(existsSync(join(summary.worktree, 'tests/ok.sh'))).toBe(false);
    expect(readFileSync(summary.patch_path!, 'utf8')).not.toContain('tests/ok.sh');
  });

  it('treats unreproducible findings as advice, except security which goes to the operator', async () => {
    const none = { kind: 'none', why: 'needs production data' };
    const { summary } = await run({
      implementer: [{ writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }],
      reviewer: [{ output: verdictWith(finding({ id: 'F1', reproduction: none }), finding({ id: 'F2', category: 'security', claim: 'token is logged.', reproduction: none })) }],
    });
    expect(summary.outcome).toBe('escalated');
    expect(summary.escalation_reason).toBe('needs_human');
    expect(summary.needs_human.map((f) => f.id)).toEqual(['F2']);
    expect(store.findings(summary.run_id).map((f) => [f.label, f.confirmation])).toEqual([['F1', 'unappliable'], ['F2', 'needs_human']]);
  });

  it('lets the operator dismiss needs_human findings at a gate', async () => {
    const none = { kind: 'none', why: 'cannot' };
    const { summary } = await run(
      {
        implementer: [{ writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }],
        reviewer: [{ output: verdictWith(finding({ category: 'data-loss', reproduction: none })) }],
      },
      { engine: { gate: async () => 'continue' } },
    );
    expect(summary.outcome).toBe('converged');
  });

  it('gives the implementer a fix attempt when verification is red, without spending a reviewer', async () => {
    const { summary, fake } = await run({
      implementer: [
        { writes: { 'src/a.ts': 'export const a = 3;\n' }, output: REPORT },
        { writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT },
      ],
      reviewer: [{ output: APPROVE }],
    });
    expect(summary.outcome).toBe('converged');
    expect(summary.rounds).toBe(1);
    expect(fake.jobs.map((j) => j.role)).toEqual(['implementer', 'implementer', 'reviewer']);
    expect(fake.jobs[1]!.prompt).toContain('Check `value` fails');
    expect(store.verificationSteps(summary.run_id).map((s) => [s.attempt, s.passed])).toEqual([[0, 0], [1, 1]]);
  });

  it('escalates verification_stuck when fix attempts run out, and never reviews red code', async () => {
    const { summary, fake } = await run({
      implementer: [
        { writes: { 'src/a.ts': 'export const a = 3;\n' }, output: REPORT },
        { writes: { 'src/a.ts': 'export const a = 4;\n' }, output: REPORT },
      ],
      reviewer: [],
    });
    expect(summary.outcome).toBe('escalated');
    expect(summary.escalation_reason).toBe('verification_stuck');
    expect(fake.jobs.every((j) => j.role === 'implementer')).toBe(true);
    expect(store.findRun(summary.run_id)?.status).toBe('escalated');
  });

  it('runs one repair turn when the verdict is invalid', async () => {
    const { summary, fake } = await run({
      implementer: [{ writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }],
      reviewer: [{ output_raw: 'LGTM!' }, { output: APPROVE }],
    });
    expect(summary.outcome).toBe('converged');
    const repair = fake.jobs[2]!;
    expect(repair.role).toBe('reviewer');
    expect(repair.prompt).toContain('did not produce a valid');
    expect(repair.resume?.session_ref).toBeTruthy();
    expect(store.workerRuns(summary.run_id).map((r) => [r.purpose, r.output_valid])).toEqual([['work', 1], ['work', 0], ['repair', 1]]);
  });

  it('continues with the patch alone when the implementer never writes a valid report', async () => {
    const { summary } = await run({
      implementer: [{ writes: { 'src/a.ts': 'export const a = 2;\n' } }, {}],
      reviewer: [{ output: APPROVE }],
    });
    expect(summary.outcome).toBe('converged');
    expect(warnings().some((w) => w.includes('no valid report'))).toBe(true);
  });

  it('escalates when no reviewer produces a verdict, rather than calling it converged', async () => {
    const { summary } = await run({
      implementer: [{ writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }],
      reviewer: [{ classification: 'crashed' }],
    });
    expect(summary.outcome).toBe('escalated');
    expect(summary.escalation_reason).toBe('worker_failed');
  });

  it('escalates git_mutated when an implementer gets a commit past the hooks, and still saves the work', async () => {
    const { summary } = await run({
      implementer: [
        {
          writes: { 'src/a.ts': 'export const a = 2;\n' },
          output: REPORT,
          run: (job) => {
            const env = { ...process.env, GIT_AUTHOR_NAME: 'r', GIT_AUTHOR_EMAIL: 'r@r', GIT_COMMITTER_NAME: 'r', GIT_COMMITTER_EMAIL: 'r@r' };
            execFileSync('git', ['add', 'src/a.ts'], { cwd: job.cwd_abs, env });
            execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'rogue'], { cwd: job.cwd_abs, env });
          },
        },
      ],
      reviewer: [],
    });
    expect(summary.outcome).toBe('escalated');
    expect(summary.escalation_reason).toBe('git_mutated');
    expect(store.workerRuns(summary.run_id)[0]!.classification).toBe('git_mutated');
    expect(readFileSync(summary.patch_path!, 'utf8')).toContain('+export const a = 2;');
    // The operator's branch did not move.
    expect(repo.run(['rev-parse', 'main']).trim()).toBe(repo.base_sha);
  });

  it('stops at max_rounds with findings open and keeps failing reproductions out of the patch', async () => {
    const { summary } = await run(
      {
        implementer: [{ writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }],
        reviewer: [{ writes: { 'tests/b.sh': 'grep -q "b = 3" src/a.ts\n' }, output: verdictWith(finding()) }],
      },
      { task: TASK.replace('max_rounds: 3', 'max_rounds: 1') },
    );
    expect(summary.outcome).toBe('escalated');
    expect(summary.escalation_reason).toBe('budget');
    expect(summary.open_findings.map((f) => f.id)).toEqual(['F1']);
    expect(summary.open_repro_files).toEqual(['tests/b.sh']);
    expect(readFileSync(summary.patch_path!, 'utf8')).not.toContain('tests/b.sh');
    expect(existsSync(join(summary.worktree, 'tests/b.sh'))).toBe(true);
  });

  it('escalates no_progress when a round trades one defect for another', async () => {
    const second = finding({ id: 'F9', claim: 'c is not exported.', reproduction: { kind: 'test', files: ['tests/c.sh'], run: 'sh tests/c.sh' } });
    const { summary } = await run({
      implementer: [
        { writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT },
        { writes: { 'src/a.ts': 'export const a = 2;\nexport const b = 3;\n' }, output: REPORT },
      ],
      reviewer: [
        { writes: { 'tests/b.sh': 'grep -q "b = 3" src/a.ts\n' }, output: verdictWith(finding()) },
        { writes: { 'tests/c.sh': 'grep -q "c = 4" src/a.ts\n' }, output: verdictWith(second) },
      ],
    });
    expect(summary.outcome).toBe('escalated');
    expect(summary.escalation_reason).toBe('no_progress');
    expect(summary.rounds).toBe(2);
  });

  it('restores a reproduction the implementer weakened instead of fixing the defect', async () => {
    const { summary } = await run({
      implementer: [
        { writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT },
        { writes: { 'tests/b.sh': 'exit 0\n' }, output: REPORT },
        { writes: { 'tests/b.sh': 'exit 0\n' }, output: REPORT },
      ],
      reviewer: [{ writes: { 'tests/b.sh': 'grep -q "b = 3" src/a.ts\n' }, output: verdictWith(finding()) }],
    });
    expect(warnings().some((w) => w.includes('modified reproduction file'))).toBe(true);
    expect(summary.outcome).toBe('escalated');
    expect(readFileSync(join(summary.worktree, 'tests/b.sh'), 'utf8')).toContain('grep');
  });

  it('rescues a rejected resume: bare flags first, then a fresh session', async () => {
    const { summary, fake } = await run({
      implementer: [
        { writes: { 'src/a.ts': 'export const a = 3;\n' }, output: REPORT },
        { classification: 'cli_usage_error' },
        { classification: 'cli_usage_error' },
        { writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT },
      ],
      reviewer: [{ output: APPROVE }],
    }, { task: TASK.replace('budget: {', 'budget: { max_worker_runs: 8,') });
    expect(summary.outcome).toBe('converged');
    const impl = fake.jobs.filter((j) => j.role === 'implementer');
    expect(impl.map((j) => [!!j.resume, !!j.no_optional_flags])).toEqual([[false, false], [true, false], [true, true], [false, false]]);
  });

  it('honours the worker-run budget', async () => {
    const { summary } = await run(
      {
        implementer: [{ writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }],
        reviewer: [],
      },
      { task: TASK.replace('budget: {', 'budget: { max_worker_runs: 1,') },
    );
    expect(summary.outcome).toBe('escalated');
    expect(summary.escalation_reason).toBe('budget');
  });

  it('skips a same-provider reviewer under enforce, and converges without review', async () => {
    global = GlobalConfigSchema.parse({ ...global, roles: { ...global.roles, reviewer: { provider: 'alpha', model: 'strong' } }, loop: { require_cross_vendor_review: 'enforce', clarify: false } });
    const { summary, fake } = await run({ implementer: [{ writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }] });
    expect(summary.outcome).toBe('converged');
    expect(fake.jobs).toHaveLength(1);
    expect(warnings().some((w) => w.includes('enforce'))).toBe(true);
  });

  it('refuses to start when the base commit is already red, before spending any worker', async () => {
    repo.write('.conductor/config.yaml', REPO_CONFIG.replace('grep -q "a = 2" src/a.ts', 'exit 1'));
    repo.run(['add', '-A']);
    repo.run(['commit', '-q', '-m', 'break the check']);
    const { summary, fake } = await run({ implementer: [], reviewer: [] }, { engine: { skip_baseline: false } });
    expect(summary.outcome).toBe('aborted');
    expect(summary.detail).toContain('already red at the base commit');
    expect(fake.jobs).toHaveLength(0);
    expect(store.verificationSteps(summary.run_id).map((s) => [s.round, s.passed])).toEqual([[0, 0]]);
  });

  it('does not run acceptance checks at baseline: they are supposed to fail until the work is done', async () => {
    const task = TASK.replace('- { id: AC1, text: a is 2 }', '- { id: AC1, text: a is 2, check: { kind: command, run: "grep -q \\"a = 2\\" src/a.ts" } }');
    repo.write('.conductor/config.yaml', REPO_CONFIG.replace('grep -q "a = 2" src/a.ts', 'test -f src/a.ts'));
    repo.run(['add', '-A']);
    repo.run(['commit', '-q', '-m', 'check that passes at base']);
    const { summary } = await run({ implementer: [{ writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }], reviewer: [{ output: APPROVE }] }, { task, engine: { skip_baseline: false } });
    expect(summary.outcome).toBe('converged');
    const steps = store.verificationSteps(summary.run_id);
    expect(steps.filter((s) => s.round === 0).map((s) => s.step_id)).toEqual(['value']);
    expect(steps.filter((s) => s.round === 1).map((s) => s.step_id)).toEqual(['value', 'acceptance:AC1']);
  });

  it('keeps files written by setup out of the patch', async () => {
    repo.write('.conductor/config.yaml', REPO_CONFIG.replace('version: 1\n', 'version: 1\nsetup:\n  run: echo generated > setup-artifact.txt\n'));
    repo.run(['add', '-A']);
    repo.run(['commit', '-q', '-m', 'setup that writes a file']);
    const { summary } = await run({ implementer: [{ writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }], reviewer: [{ output: APPROVE }] });
    expect(summary.outcome).toBe('converged');
    expect(summary.patch?.files_changed).toEqual(['src/a.ts']);
    expect(warnings().some((w) => w.includes('setup changed 1 file(s) (setup-artifact.txt)'))).toBe(true);
  });

  it('warns when the patch deletes files', async () => {
    const { summary } = await run({
      implementer: [{ writes: { 'src/a.ts': 'export const a = 2;\n', 'README.md': null }, output: REPORT }],
      reviewer: [{ output: APPROVE }],
    });
    expect(summary.patch?.deleted).toEqual(['README.md']);
    expect(warnings().some((w) => w.includes('deletes README.md'))).toBe(true);
  });

  it('aborts when the operator signals, killing the running worker', async () => {
    // Abort on the event, not on a timer: under load, setup alone can outlast any fixed delay.
    const ac = new AbortController();
    const observer = (e: ConductorEvent): void => {
      events.push(e);
      if (e.type === 'worker_started') ac.abort();
    };
    const { summary } = await run({ implementer: [{ hang: true }] }, { engine: { signal: ac.signal, observer } });
    expect(summary.outcome).toBe('aborted');
    expect(store.workerRuns(summary.run_id).map((w) => w.classification)).toEqual(['killed']);
  });

  it('aborts cleanly when the signal arrives before any worker has started', async () => {
    const ac = new AbortController();
    ac.abort();
    const { summary, fake } = await run({ implementer: [] }, { engine: { signal: ac.signal } });
    expect(summary.outcome).toBe('aborted');
    expect(fake.jobs).toHaveLength(0);
    expect(store.workerRuns(summary.run_id)).toEqual([]);
  });
});

describe('clarify', () => {
  const QUESTION = { id: 'Q1', question: 'Should b be exported as well?', why: 'Changes the public API.', options: ['yes', 'no'], default: 'no' };
  const asks = (...questions: unknown[]) => ({ schema_version: 1, questions });
  const withClarify = (): void => {
    global = GlobalConfigSchema.parse({ ...global, loop: { ...global.loop, clarify: true } });
  };
  const readPack = (s: RunSummary, rel: string): string => readFileSync(join(s.run_dir, rel), 'utf8');

  it('asks before coding in a read-only turn, then resumes the same session with binding decisions', async () => {
    withClarify();
    const seen: string[] = [];
    const { summary, fake } = await run(
      {
        implementer: [{ output: asks(QUESTION) }, { writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }],
        reviewer: [{ output: APPROVE }],
      },
      { engine: { questions: async ({ questions }) => (seen.push(...questions.map((q) => q.id)), { Q1: 'yes' }) } },
    );
    expect(summary.outcome).toBe('converged');
    expect(seen).toEqual(['Q1']);

    const [clarify, work] = fake.jobs;
    expect(clarify!.role).toBe('implementer');
    expect(clarify!.policy.fs).toBe('read-only');
    expect(clarify!.output.files[0]!.path_rel).toBe('.conductor/out/questions.json');
    expect(clarify!.prompt).toContain('Before you write any code');
    expect(work!.policy.fs).toBe('workspace-write');
    expect(work!.resume?.session_ref).toBe('fake-session-1');

    expect(summary.clarifications).toEqual([{ id: 'Q1', stage: 'before_coding', question: QUESTION.question, answer: 'yes', source: 'operator' }]);
    const decision = 'Should b be exported as well? → yes (the operator decided)';
    expect(readPack(summary, 'rounds/1/implement-0/pack/CONTEXT.md')).toContain(decision);
    expect(readPack(summary, 'rounds/1/review-1/pack/CONTEXT.md')).toContain(decision);
    expect(store.workerRuns(summary.run_id).map((w) => [w.round, w.purpose])).toEqual([[0, 'clarify'], [1, 'work'], [1, 'work']]);
  });

  it("without a terminal, takes the implementer's defaults and says nobody confirmed them", async () => {
    withClarify();
    const { summary } = await run({
      implementer: [{ output: asks(QUESTION) }, { writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }],
      reviewer: [{ output: APPROVE }],
    });
    expect(summary.clarifications).toEqual([{ id: 'Q1', stage: 'before_coding', question: QUESTION.question, answer: 'no', source: 'default' }]);
    expect(readPack(summary, 'rounds/1/implement-0/pack/CONTEXT.md')).toContain("→ no (the implementer's own recommendation; nobody confirmed it)");
  });

  it('reads the questions from the final message, since the turn cannot write files', async () => {
    withClarify();
    const { summary } = await run({
      implementer: [{ final_text: '```json\n' + JSON.stringify(asks()) + '\n```' }, { writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }],
      reviewer: [{ output: APPROVE }],
    });
    expect(summary.outcome).toBe('converged');
    expect(summary.clarifications).toEqual([]);
    expect(events.some((e) => e.type === 'clarified' && e.clarifications.length === 0)).toBe(true);
  });

  it('keeps at most five questions', async () => {
    withClarify();
    const many = Array.from({ length: 7 }, (_, i) => ({ ...QUESTION, id: `Q${i + 1}` }));
    const { summary } = await run({
      implementer: [{ output: asks(...many) }, { writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }],
      reviewer: [{ output: APPROVE }],
    });
    expect(summary.clarifications.map((q) => q.id)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);
    expect(warnings().some((w) => w.includes('asked 7 questions'))).toBe(true);
  });

  it('never fails the run when the clarify turn fails; the implementer starts fresh', async () => {
    withClarify();
    const { summary, fake } = await run({
      implementer: [{ classification: 'crashed' }, { writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }],
      reviewer: [{ output: APPROVE }],
    });
    expect(summary.outcome).toBe('converged');
    expect(warnings().some((w) => w.startsWith('clarify turn crashed'))).toBe(true);
    expect(fake.jobs[1]!.resume).toBeUndefined();
  });

  it('is skipped when the task says clarify: false', async () => {
    withClarify();
    const { fake } = await run(
      { implementer: [{ writes: { 'src/a.ts': 'export const a = 2;\n' }, output: REPORT }], reviewer: [{ output: APPROVE }] },
      { task: TASK.replace('gates: [before_apply]', 'gates: [before_apply]\nclarify: false') },
    );
    expect(fake.jobs.map((j) => j.policy.fs)).toEqual(['workspace-write', 'workspace-write']);
  });

  it("surfaces the implementer's leftover questions and deliberate omissions", async () => {
    const report = { ...REPORT, open_questions: ['Should a be configurable?'], did_not_do: ['No migration for old data.'] };
    const { summary } = await run({
      implementer: [{ writes: { 'src/a.ts': 'export const a = 2;\n' }, output: report }],
      reviewer: [{ output: APPROVE }],
    });
    expect(summary.open_questions).toEqual(['Should a be configurable?']);
    expect(summary.did_not_do).toEqual(['No migration for old data.']);
    const stored = JSON.parse(readFileSync(join(summary.run_dir, 'summary.json'), 'utf8')) as RunSummary;
    expect(stored.open_questions).toEqual(['Should a be configurable?']);
  });
});

describe('asking mid-work', () => {
  const Q = { id: 'Q1', question: 'Extend AuthMiddleware or SessionGuard?', why: 'Decides which layer changes.', options: ['AuthMiddleware', 'SessionGuard'], default: 'AuthMiddleware' };
  const CHOICE = { id: 'D1', question: 'Error message wording', chosen: 'Invalid value', alternatives: ['Value must be 2'] };
  const stop = (...questions: unknown[]) => ({ output: { ...REPORT, blocking_questions: questions } });
  const done = (extra: object = {}) => ({ writes: { 'src/a.ts': 'export const a = 2;\n' }, output: { ...REPORT, ...extra } });
  const setLoop = (loop: object): void => {
    global = GlobalConfigSchema.parse({ ...global, loop: { ...global.loop, ...loop } });
  };
  const impl = (fake: { jobs: { role: string }[] }) => fake.jobs.filter((j) => j.role === 'implementer') as ReturnType<typeof createFakeAdapter>['jobs'];
  const reviewerContext = (s: RunSummary): string => readFileSync(join(s.run_dir, 'rounds/1/review-1/pack/CONTEXT.md'), 'utf8');

  it('tells an attended implementer to decide small things and stop only for costly guesses', async () => {
    const { fake } = await run({ implementer: [done()], reviewer: [{ output: APPROVE }] }, { engine: { questions: async () => ({}) } });
    expect(fake.jobs[0]!.prompt).toContain('Stop only for a question where a wrong guess would force redoing most of the work');
    expect(fake.jobs[0]!.prompt).toContain('You may stop at most 3 more times');
  });

  it('tells an unattended implementer that nobody can answer', async () => {
    const { fake } = await run({ implementer: [done()], reviewer: [{ output: APPROVE }] });
    expect(fake.jobs[0]!.prompt).toContain('Nobody can answer questions during this run');
  });

  it('pauses on a blocking question and resumes the same session with the answer', async () => {
    const seen: string[] = [];
    const { summary, fake } = await run(
      { implementer: [stop(Q), done()], reviewer: [{ output: APPROVE }] },
      { engine: { questions: async ({ stage, questions }) => (seen.push(`${stage}:${questions[0]!.id}`), { Q1: 'SessionGuard' }) } },
    );
    expect(summary.outcome).toBe('converged');
    expect(seen).toEqual(['blocking:Q1']);
    const [first, resumed] = impl(fake);
    expect(resumed!.resume?.session_ref).toBe('fake-session-1');
    expect(resumed!.prompt).toContain('Your questions have been answered');
    expect(resumed!.prompt).toContain('Extend AuthMiddleware or SessionGuard? → SessionGuard');
    expect(first!.cwd_abs).toBe(resumed!.cwd_abs);
    expect(store.workerRuns(summary.run_id).map((w) => w.purpose)).toEqual(['work', 'answer', 'work']);
    expect(summary.clarifications).toEqual([{ id: 'Q1', stage: 'blocking', question: Q.question, answer: 'SessionGuard', source: 'operator' }]);
    expect(reviewerContext(summary)).toContain('→ SessionGuard (the operator decided)');
  });

  it("uses the recommendation when nobody is there, and says nobody confirmed it", async () => {
    const { summary } = await run({ implementer: [stop(Q), done()], reviewer: [{ output: APPROVE }] });
    expect(summary.clarifications[0]).toMatchObject({ stage: 'blocking', answer: 'AuthMiddleware', source: 'default' });
    expect(reviewerContext(summary)).toContain("→ AuthMiddleware (the implementer's own recommendation; nobody confirmed it)");
  });

  it('stops asking the operator once the allowance is used, and says so', async () => {
    setLoop({ max_question_stops: 1 });
    const seen: string[] = [];
    const { summary, fake } = await run(
      { implementer: [stop(Q), stop({ ...Q, id: 'Q2', question: 'Second question?' }), done()], reviewer: [{ output: APPROVE }] },
      { engine: { questions: async ({ questions }) => (seen.push(questions[0]!.id), { [questions[0]!.id]: 'SessionGuard' }) } },
    );
    expect(seen).toEqual(['Q1']);
    expect(summary.clarifications.map((c) => [c.id, c.source])).toEqual([['Q1', 'operator'], ['Q2', 'default']]);
    expect(impl(fake)[1]!.prompt).toContain('You have used every stop allowed in this run');
  });

  it('never waits forever: after the timeout the recommendation stands', async () => {
    setLoop({ answer_timeout_ms: 50 });
    const { summary } = await run(
      { implementer: [stop(Q), done()], reviewer: [{ output: APPROVE }] },
      { engine: { questions: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({}))) } },
    );
    expect(summary.outcome).toBe('converged');
    expect(summary.clarifications[0]).toMatchObject({ answer: 'AuthMiddleware', source: 'default' });
    expect(warnings().some((w) => w.startsWith('no answer within'))).toBe(true);
  });

  it("shows the implementer's own choices before review; accepting them costs no extra turn", async () => {
    const shown: string[] = [];
    const { summary, fake } = await run(
      { implementer: [done({ decisions_made: [CHOICE] })], reviewer: [{ output: APPROVE }] },
      { engine: { questions: async () => ({}), choices: async ({ choices }) => (shown.push(...choices.map((c) => c.id)), {}) } },
    );
    expect(shown).toEqual(['D1']);
    expect(impl(fake)).toHaveLength(1);
    expect(summary.clarifications).toEqual([{ id: 'D1', stage: 'own_choice', question: CHOICE.question, answer: 'Invalid value', source: 'operator' }]);
    expect(reviewerContext(summary)).toContain("→ Invalid value (the implementer's choice, accepted by the operator)");
  });

  it('sends an overruled choice back to the implementer, re-verifies, then reviews', async () => {
    const { summary, fake } = await run(
      {
        implementer: [done({ decisions_made: [CHOICE] }), { writes: { 'src/a.ts': "export const a = 2; // 'Value must be 2'\n" }, output: REPORT }],
        reviewer: [{ output: APPROVE }],
      },
      { engine: { questions: async () => ({}), choices: async () => ({ D1: 'Value must be 2' }) } },
    );
    expect(summary.outcome).toBe('converged');
    const fix = impl(fake)[1]!;
    expect(fix.resume?.session_ref).toBe('fake-session-1');
    expect(fix.prompt).toContain('The operator overruled your choice: Error message wording');
    expect(fix.prompt).toContain('The operator decided: Value must be 2');
    expect(store.verificationSteps(summary.run_id).map((s) => s.attempt)).toEqual([0, 1]);
    expect(summary.clarifications[0]).toMatchObject({ stage: 'own_choice', answer: 'Value must be 2', overruled_from: 'Invalid value' });
    expect(reviewerContext(summary)).toContain('→ Value must be 2 (the operator decided, replacing the implementer\'s choice "Invalid value")');
    expect(fake.jobs.map((j) => j.role)).toEqual(['implementer', 'implementer', 'reviewer']);
  });

  it('records own choices as unconfirmed when nobody is there', async () => {
    const { summary, fake } = await run({ implementer: [done({ decisions_made: [CHOICE] })], reviewer: [{ output: APPROVE }] });
    expect(impl(fake)).toHaveLength(1);
    expect(summary.clarifications[0]).toMatchObject({ stage: 'own_choice', source: 'default' });
  });

  it('does not lose a choice made in an earlier fix attempt', async () => {
    const shown: string[] = [];
    await run(
      {
        implementer: [
          { writes: { 'src/a.ts': 'export const a = 3;\n' }, output: { ...REPORT, decisions_made: [CHOICE] } },
          done(),
        ],
        reviewer: [{ output: APPROVE }],
      },
      { engine: { questions: async () => ({}), choices: async ({ choices }) => (shown.push(...choices.map((c) => c.id)), {}) } },
    );
    expect(shown).toEqual(['D1']);
  });
});


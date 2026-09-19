import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilitySet, Detection, WorkerAdapter, WorkerEvent, WorkerJob, WorkerResult } from '@agent-conductor/adapter-api';
import type { Paths, ResolvedTarget } from '../config/load.js';
import { loadRepoConfig } from '../config/load.js';
import { BASELINE_ALLOWED_COMMANDS, GIT_MUTATION_DENYLIST } from '../config/policy.js';
import type { GlobalConfig } from '../config/schema.js';
import type { TaskDraft } from '../contracts/draft.js';
import type { TaskSpec } from '../contracts/task.js';
import { OUT_DIR_REL, outputSpec, PACK_DIR_REL } from '../contracts/json-schema.js';
import { prepareProviders } from '../dispatcher/providers.js';
import { readRoleOutput, repairPrompt } from '../engine/output.js';
import { revParse } from '../git/exec.js';
import { ulid } from '../ids.js';
import { loadInstructions } from '../instructions/load.js';
import { createWorktree, ensureHooksDir, removeWorktree } from '../isolation/worktree.js';
import type { Store } from '../store/store.js';
import { buildPlan, describePlan } from '../verifier/verifier.js';

const TEMPLATE = fileURLToPath(new URL('../../templates/draft-task.md', import.meta.url));
const DRAFT_TIMEOUT_MS = 10 * 60_000;
const NO_TASK = { verification: { add: [], disable: [] }, acceptance: [] } as unknown as TaskSpec;

export interface DraftTaskOptions {
  repo_abs: string;
  request: string;
  target: ResolvedTarget;
  global: GlobalConfig;
  adapters: Record<string, WorkerAdapter>;
  store: Store;
  paths: Paths;
  /** Other repositories the drafter may read, e.g. siblings in the same workspace folder. */
  related_repos_abs?: string[];
  onEvent?: (e: WorkerEvent) => void;
  signal?: AbortSignal;
}

export interface DraftResult {
  draft?: TaskDraft;
  errors?: string[];
  classification: string;
  detail?: string;
  log_dir: string;
}

/**
 * One read-only model turn that turns a request into a task: a precise
 * description, acceptance criteria with runnable checks, the files involved.
 * Runs in a temporary worktree at HEAD, so it sees what a run would start
 * from, and removes it afterwards. Nothing is saved; the operator reviews it.
 */
export async function draftTask(o: DraftTaskOptions): Promise<DraftResult> {
  const provider = (await prepareProviders(o.global, o.adapters, o.store, o.paths, [o.target.provider])).get(o.target.provider)!;
  const id = ulid();
  const logDir = join(o.paths.home, 'drafts', id);
  const wt = join(o.paths.worktrees, `draft-${id}`);
  mkdirSync(logDir, { recursive: true });
  ensureHooksDir(o.paths.hooks);
  await createWorktree({ repo_abs: o.repo_abs, path_abs: wt, base_sha: await revParse(o.repo_abs, 'HEAD'), hooks_dir: o.paths.hooks });
  try {
    const repoCfg = loadRepoConfig(o.repo_abs);
    const instructions = await loadInstructions(wt, repoCfg.instructions.sources, { repo_abs: o.repo_abs });
    const out = outputSpec('task_draft');
    const related = o.related_repos_abs ?? [];
    const pack = join(wt, PACK_DIR_REL);
    writeFileSync(
      join(pack, 'CONTEXT.md'),
      [
        '# Context',
        '',
        `- Repository: ${o.repo_abs} (your current directory is a copy of it at HEAD)`,
        '',
        '## Checks every change must pass',
        '',
        describePlan(buildPlan(repoCfg, NO_TASK)),
        '',
        ...(related.length ? ['## Related repositories you may read', '', ...related.map((r) => `- ${r}`), ''] : []),
      ].join('\n'),
    );
    writeFileSync(
      join(pack, 'INSTRUCTIONS.md'),
      instructions.docs.length ? instructions.docs.map((d) => `<!-- source: ${d.source} -->\n\n## ${d.title}\n\n${d.body}\n`).join('\n---\n\n') : 'No instruction documents.\n',
    );
    writeFileSync(join(pack, 'OUTPUT-SCHEMA.json'), JSON.stringify(out.json_schema, null, 2) + '\n');
    const prompt = readFileSync(TEMPLATE, 'utf8').replaceAll('{{pack_dir}}', PACK_DIR_REL).replace('{{request}}', o.request.trim());
    writeFileSync(join(logDir, 'PROMPT.md'), prompt);

    const job: WorkerJob = {
      worker_run_id: id,
      role: 'implementer',
      cwd_abs: wt,
      prompt,
      model_id: o.target.model_id,
      ...(o.target.effort ? { effort: o.target.effort } : {}),
      policy: {
        fs: 'read-only',
        network: false,
        allowed_commands: [...BASELINE_ALLOWED_COMMANDS],
        denied_commands: [...GIT_MUTATION_DENYLIST],
        extra_readable_dirs_abs: related,
      },
      output: { dir_rel: OUT_DIR_REL, files: [{ path_rel: out.path_rel, schema: out.json_schema }] },
      timeouts: { idle_ms: o.global.loop.idle_timeout_ms, total_ms: DRAFT_TIMEOUT_MS },
      env: {},
      log_dir_abs: join(logDir, 'turn-1'),
    };
    let result = await supervise(provider.adapter, provider.detection, provider.caps, job, o);
    if (result.classification !== 'ok') return { classification: result.classification, ...(result.detail ? { detail: result.detail } : {}), log_dir: logDir };
    let parsed = readRoleOutput<TaskDraft>(wt, 'task_draft', result.final_text);
    if (!parsed.ok && result.session_ref && provider.caps.resume && !o.signal?.aborted) {
      const repair = repairPrompt('task_draft', parsed.errors, parsed.raw);
      result = await supervise(provider.adapter, provider.detection, provider.caps, { ...job, prompt: repair, resume: { session_ref: result.session_ref }, log_dir_abs: join(logDir, 'turn-2') }, o);
      if (result.classification === 'ok') parsed = readRoleOutput<TaskDraft>(wt, 'task_draft', result.final_text);
    }
    if (!parsed.ok) return { classification: 'invalid_output', errors: parsed.errors, log_dir: logDir };
    writeFileSync(join(logDir, 'draft.json'), JSON.stringify(parsed.value, null, 2));
    return { draft: normalise(parsed.value, wt, o.repo_abs), classification: 'ok', log_dir: logDir };
  } finally {
    await removeWorktree(o.repo_abs, wt);
  }
}

/** Paths inside the throwaway worktree are paths inside the repo. */
function normalise(d: TaskDraft, wt: string, repo: string): TaskDraft {
  const fix = (p: string): string => (p.startsWith(wt) ? relative(wt, p) : p.startsWith(repo + '/') ? relative(repo, p) : p);
  return { ...d, touch_hint: d.touch_hint.map(fix), context_files: d.context_files.map(fix) };
}

async function supervise(adapter: WorkerAdapter, d: Detection, caps: CapabilitySet, job: WorkerJob, o: DraftTaskOptions): Promise<WorkerResult> {
  const handle = adapter.start(job, d, caps);
  const timer = setTimeout(() => handle.kill('SIGTERM', 'timeout_total'), job.timeouts.total_ms);
  const onAbort = (): void => handle.kill('SIGTERM', 'killed');
  if (o.signal?.aborted) onAbort();
  else o.signal?.addEventListener('abort', onAbort, { once: true });
  const pump = (async (): Promise<void> => {
    for await (const e of handle.events) o.onEvent?.(e);
  })();
  try {
    const [result] = await Promise.all([handle.result, pump]);
    return result;
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
  }
}

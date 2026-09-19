import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import picomatch from 'picomatch';
import { OUT_DIR_REL, PACK_DIR_REL } from '../contracts/json-schema.js';
import type { PatchInfo } from '../contracts/work-product.js';
import { git, gitToFile } from '../git/exec.js';
import { ulid } from '../ids.js';

const EXCLUDES = [`:(exclude)${PACK_DIR_REL}`, `:(exclude)${OUT_DIR_REL}`];

export interface ExtractPatchSpec {
  worktree_abs: string;
  base_sha: string;
  /** Where to write the patch. */
  patch_path_abs: string;
  touch_hint?: string[];
  /** Extra paths to leave out of the patch (e.g. harvested reproductions that are still open). */
  exclude_paths?: string[];
  /**
   * Files setup created or changed (from `worktreeState` right after setup). Left out of the patch while they
   * are still exactly as setup left them: a lockfile an install wrote is not the worker's change.
   */
  setup_state?: Map<string, string | null>;
}

/**
 * Every path whose content differs from base_sha right now, with its blob id
 * (null when deleted). Uses a throwaway index, so the worktree's own index is untouched.
 */
export async function worktreeState(worktree_abs: string, base_sha: string, scratch_dir_abs: string): Promise<Map<string, string | null>> {
  mkdirSync(scratch_dir_abs, { recursive: true });
  const tmpIndex = join(scratch_dir_abs, `.state-index-${ulid()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    await git(worktree_abs, ['read-tree', base_sha], { env });
    await git(worktree_abs, ['add', '-A', '--', '.'], { env });
    const status = (await git(worktree_abs, ['diff', '--cached', '--name-status', '--no-renames', '-z', base_sha], { env })).stdout.split('\0').filter(Boolean);
    const blobs = new Map<string, string>();
    for (const rec of (await git(worktree_abs, ['ls-files', '-s', '-z'], { env })).stdout.split('\0').filter(Boolean)) {
      const tab = rec.indexOf('\t');
      blobs.set(rec.slice(tab + 1), rec.slice(0, tab).split(' ')[1]!);
    }
    const state = new Map<string, string | null>();
    for (let i = 0; i + 1 < status.length; i += 2) state.set(status[i + 1]!, status[i] === 'D' ? null : (blobs.get(status[i + 1]!) ?? null));
    return state;
  } finally {
    rmSync(tmpIndex, { force: true });
    rmSync(`${tmpIndex}.lock`, { force: true });
  }
}

/**
 * The worktree's changes against base_sha as one patch, including new files,
 * excluding gitignored files and the conductor's own directories.
 *
 * Uses a throwaway index so the worktree's real index is never touched and
 * whatever a worker staged (or did not) cannot change the result.
 */
export async function extractPatch(spec: ExtractPatchSpec): Promise<PatchInfo> {
  mkdirSync(dirname(spec.patch_path_abs), { recursive: true });
  const tmpIndex = join(dirname(spec.patch_path_abs), `.index-${ulid()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  const extra = (spec.exclude_paths ?? []).map((p) => `:(exclude,literal)${p}`);
  const leftAsSetupMadeThem: string[] = [];
  if (spec.setup_state?.size) {
    const now = await worktreeState(spec.worktree_abs, spec.base_sha, dirname(spec.patch_path_abs));
    for (const [path, blob] of spec.setup_state) if (now.has(path) && now.get(path) === blob) leftAsSetupMadeThem.push(path);
  }
  const excludes = [...EXCLUDES, ...extra, ...leftAsSetupMadeThem.map((p) => `:(exclude,literal)${p}`)];
  try {
    await git(spec.worktree_abs, ['read-tree', spec.base_sha], { env });
    // Not the .conductor excludes here: `git add` refuses a pathspec naming an ignored path, and the operator
    // may ignore .conductor/ themselves. The directories ignore themselves, so `add -A` never picks them up.
    await git(spec.worktree_abs, ['add', '-A', '--', '.', ...extra], { env });
    const range = ['--cached', '--no-renames', '--no-color', '--no-ext-diff', spec.base_sha, '--', '.', ...excludes];
    await gitToFile(spec.worktree_abs, ['diff', '--binary', ...range], spec.patch_path_abs, { env });
    const numstat = (await git(spec.worktree_abs, ['diff', '--numstat', '-z', ...range], { env })).stdout;
    const status = (await git(spec.worktree_abs, ['diff', '--name-status', '-z', ...range], { env })).stdout;

    const files: string[] = [];
    const binary: string[] = [];
    let insertions = 0;
    let deletions = 0;
    for (const rec of numstat.split('\0').filter(Boolean)) {
      const [ins, del, ...rest] = rec.split('\t');
      const path = rest.join('\t');
      files.push(path);
      if (ins === '-' || del === '-') binary.push(path);
      else {
        insertions += Number(ins);
        deletions += Number(del);
      }
    }
    const added: string[] = [];
    const st = status.split('\0').filter(Boolean);
    const deleted: string[] = [];
    for (let i = 0; i + 1 < st.length; i += 2) {
      if (st[i] === 'A') added.push(st[i + 1]!);
      if (st[i] === 'D') deleted.push(st[i + 1]!);
    }

    const hint = spec.touch_hint ?? [];
    const inHint = hint.length ? picomatch(hint, { dot: true }) : () => true;
    const bytes = readFileSync(spec.patch_path_abs);
    return {
      path_abs: spec.patch_path_abs,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      files_changed: files.sort(),
      insertions,
      deletions,
      binary_files: binary,
      outside_touch_hint: files.filter((f) => !inHint(f)),
      untracked_added: added.sort(),
      deleted: deleted.sort(),
      empty: statSync(spec.patch_path_abs).size === 0,
    };
  } finally {
    rmSync(tmpIndex, { force: true });
    rmSync(`${tmpIndex}.lock`, { force: true });
  }
}

/**
 * Apply a conductor-produced patch to a working tree. Stages nothing, ever.
 *
 * `git apply --3way` implies `--index`, which would stage the result. So the
 * three-way path runs against a throwaway index seeded from HEAD: the working
 * tree gets the merged content (or conflict markers), and the real index is
 * never opened for writing.
 */
export async function applyPatch(worktree_abs: string, patch_path_abs: string, opts: { threeWay?: boolean } = {}): Promise<void> {
  if (statSync(patch_path_abs).size === 0) return;
  if (!opts.threeWay) {
    await git(worktree_abs, ['apply', '--whitespace=nowarn', patch_path_abs]);
    return;
  }
  const tmpIndex = join(tmpdir(), `conductor-apply-index-${ulid()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    await git(worktree_abs, ['read-tree', 'HEAD'], { env });
    // A freshly read tree has no stat data; without this git reports every file as "does not match index".
    await git(worktree_abs, ['update-index', '-q', '--refresh'], { env, allowFail: true });
    await git(worktree_abs, ['apply', '--3way', '--whitespace=nowarn', patch_path_abs], { env });
  } finally {
    rmSync(tmpIndex, { force: true });
    rmSync(`${tmpIndex}.lock`, { force: true });
  }
}

/** Would the patch apply cleanly? */
export async function checkPatch(worktree_abs: string, patch_path_abs: string): Promise<{ ok: boolean; detail: string }> {
  if (statSync(patch_path_abs).size === 0) return { ok: true, detail: 'empty patch' };
  const r = await git(worktree_abs, ['apply', '--check', '--whitespace=nowarn', patch_path_abs], { allowFail: true });
  return { ok: r.code === 0, detail: r.stderr.trim() };
}

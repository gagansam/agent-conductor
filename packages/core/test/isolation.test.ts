import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditWorktree, snapshotGit } from '../src/isolation/audit.js';
import { applyPatch, checkPatch, extractPatch, worktreeState } from '../src/isolation/diff.js';
import { harvest, restoreHarvested, unharvest } from '../src/isolation/harvest.js';
import { createWorktree, ensureHooksDir, listWorktrees, removeWorktree } from '../src/isolation/worktree.js';
import { makeTempRepo, type TempRepo } from './helpers/repo.js';

let repo: TempRepo;
let hooks: string;

beforeEach(() => {
  repo = makeTempRepo({ 'README.md': '# temp\n', 'src/a.ts': 'export const a = 1;\n', '.gitignore': 'node_modules/\n' });
  hooks = join(repo.scratch, 'hooks');
  ensureHooksDir(hooks);
});
afterEach(() => repo.dispose());

const wt = (name: string): string => join(repo.scratch, 'worktrees', name);
const make = async (name: string): Promise<string> => {
  await createWorktree({ repo_abs: repo.root, path_abs: wt(name), base_sha: repo.base_sha, hooks_dir: hooks });
  return wt(name);
};

describe('worktree', () => {
  it('is detached at base_sha with self-ignoring conductor dirs', async () => {
    const w = await make('impl');
    expect(repo.run(['rev-parse', 'HEAD'], w).trim()).toBe(repo.base_sha);
    expect(repo.run(['status', '--porcelain'], w).trim()).toBe('');
    expect(existsSync(join(w, '.conductor/pack/.gitignore'))).toBe(true);
    expect(await listWorktrees(repo.root)).toContain(w);
  });

  it('is removed cleanly', async () => {
    const w = await make('gone');
    await removeWorktree(repo.root, w);
    expect(existsSync(w)).toBe(false);
    expect(await listWorktrees(repo.root)).not.toContain(w);
  });

  it('refuses a commit made from inside, even with --no-verify', async () => {
    const w = await make('impl');
    repo.write('src/a.ts', 'export const a = 2;\n', w);
    repo.run(['add', '-A'], w);
    expect(() => repo.run(['commit', '-q', '-m', 'rogue'], w)).toThrow();
    expect(() => repo.run(['commit', '-q', '--no-verify', '-m', 'rogue'], w)).toThrow();
    expect(repo.run(['rev-parse', 'HEAD'], w).trim()).toBe(repo.base_sha);
    expect(repo.run(['rev-parse', 'main']).trim()).toBe(repo.base_sha);
  });

  it('does not change hooks in the primary checkout', async () => {
    await make('impl');
    repo.write('README.md', '# changed\n');
    repo.run(['add', '-A']);
    repo.run(['commit', '-q', '-m', 'operator commit']);
    expect(repo.run(['log', '--oneline']).trim().split('\n')).toHaveLength(2);
  });
});

describe('audit', () => {
  it('passes on an untouched tree and warns on a dirty index', async () => {
    const w = await make('impl');
    const before = await snapshotGit(w);
    expect(await auditWorktree(w, repo.base_sha, before)).toEqual([]);
    repo.write('src/a.ts', 'export const a = 3;\n', w);
    repo.run(['add', '-A'], w);
    const v = await auditWorktree(w, repo.base_sha, before);
    expect(v.map((x) => [x.code, x.severity])).toEqual([['index_dirty', 'warn']]);
  });

  it('flags a moved HEAD as fatal', async () => {
    const w = await make('impl');
    const before = await snapshotGit(w);
    // Simulate a worker that got past every other layer.
    repo.run(['config', '--worktree', '--unset', 'core.hooksPath'], w);
    repo.write('src/a.ts', 'export const a = 4;\n', w);
    repo.run(['add', '-A'], w);
    repo.run(['commit', '-q', '-m', 'rogue'], w);
    const v = await auditWorktree(w, repo.base_sha, before);
    expect(v.some((x) => x.code === 'head_moved' && x.severity === 'fatal')).toBe(true);
  });
});

describe('patch', () => {
  it('captures modified, new and deleted files but not ignored or conductor files', async () => {
    const w = await make('impl');
    repo.write('src/a.ts', 'export const a = 2;\n', w);
    repo.write('src/new.ts', 'export const n = 1;\n', w);
    repo.write('node_modules/x/index.js', 'ignored', w);
    repo.write('.conductor/out/report.json', '{}', w);
    repo.write('.conductor/pack/PROMPT.md', 'prompt', w);
    const info = await extractPatch({
      worktree_abs: w,
      base_sha: repo.base_sha,
      patch_path_abs: join(repo.scratch, 'run/result.patch'),
      touch_hint: ['src/a.ts'],
    });
    expect(info.empty).toBe(false);
    expect(info.files_changed).toEqual(['src/a.ts', 'src/new.ts']);
    expect(info.untracked_added).toEqual(['src/new.ts']);
    expect(info.outside_touch_hint).toEqual(['src/new.ts']);
    expect(info.insertions).toBe(2);
    expect(info.deletions).toBe(1);
    // The worktree's real index was never touched.
    expect(repo.run(['diff', '--cached', '--name-only'], w).trim()).toBe('');
  });

  it('works when the operator ignores .conductor/ themselves', async () => {
    writeFileSync(join(repo.root, '.git', 'info', 'exclude'), '.conductor/\n');
    const w = await make('impl');
    repo.write('src/a.ts', 'export const a = 2;\n', w);
    repo.write('.conductor/out/report.json', '{}', w);
    const info = await extractPatch({ worktree_abs: w, base_sha: repo.base_sha, patch_path_abs: join(repo.scratch, 'run/ignored.patch') });
    expect(info.files_changed).toEqual(['src/a.ts']);
  });

  it('leaves out what setup wrote, unless the worker changes it afterwards', async () => {
    const w = await make('impl');
    repo.write('package-lock.json', '{"lockfileVersion": 3}\n', w);
    repo.write('README.md', '# rewritten by setup\n', w);
    const setupState = await worktreeState(w, repo.base_sha, join(repo.scratch, 'run'));
    expect([...setupState.keys()].sort()).toEqual(['README.md', 'package-lock.json']);

    repo.write('src/a.ts', 'export const a = 2;\n', w);
    const patchPath = join(repo.scratch, 'run/setup.patch');
    const first = await extractPatch({ worktree_abs: w, base_sha: repo.base_sha, patch_path_abs: patchPath, setup_state: setupState });
    expect(first.files_changed).toEqual(['src/a.ts']);

    // The worker adds a dependency: now the lockfile is its change too.
    repo.write('package-lock.json', '{"lockfileVersion": 3, "packages": {}}\n', w);
    const second = await extractPatch({ worktree_abs: w, base_sha: repo.base_sha, patch_path_abs: patchPath, setup_state: setupState });
    expect(second.files_changed).toEqual(['package-lock.json', 'src/a.ts']);
  });

  it('reports an empty patch', async () => {
    const w = await make('impl');
    const info = await extractPatch({ worktree_abs: w, base_sha: repo.base_sha, patch_path_abs: join(repo.scratch, 'run/empty.patch') });
    expect(info.empty).toBe(true);
    expect(info.files_changed).toEqual([]);
  });

  it('round-trips into a second worktree without staging anything', async () => {
    const impl = await make('impl');
    repo.write('src/a.ts', 'export const a = 2;\n', impl);
    repo.write('src/new.ts', 'export const n = 1;\n', impl);
    const patch = join(repo.scratch, 'run/result.patch');
    await extractPatch({ worktree_abs: impl, base_sha: repo.base_sha, patch_path_abs: patch });

    const review = await make('review-1');
    expect((await checkPatch(review, patch)).ok).toBe(true);
    await applyPatch(review, patch);
    expect(readFileSync(join(review, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(readFileSync(join(review, 'src/new.ts'), 'utf8')).toBe('export const n = 1;\n');
    expect(repo.run(['diff', '--cached', '--name-only'], review).trim()).toBe('');
  });

  it('applies three-way without staging anything, even though --3way implies --index', async () => {
    const impl = await make('impl');
    repo.write('src/a.ts', 'export const a = 2;\n', impl);
    const patch = join(repo.scratch, 'run/result.patch');
    await extractPatch({ worktree_abs: impl, base_sha: repo.base_sha, patch_path_abs: patch });
    // The operator's checkout has moved on in an unrelated file since the run started.
    repo.write('README.md', '# moved on\n');
    repo.run(['add', '-A']);
    repo.run(['commit', '-q', '-m', 'unrelated']);
    await applyPatch(repo.root, patch, { threeWay: true });
    expect(readFileSync(join(repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(repo.run(['diff', '--cached', '--name-only']).trim()).toBe('');
    expect(repo.run(['status', '--porcelain']).trim()).toBe('M src/a.ts');
  });

  it('can leave named paths out', async () => {
    const w = await make('impl');
    repo.write('src/a.ts', 'export const a = 2;\n', w);
    repo.write('tests/repro.test.ts', 'fails', w);
    const info = await extractPatch({
      worktree_abs: w,
      base_sha: repo.base_sha,
      patch_path_abs: join(repo.scratch, 'run/x.patch'),
      exclude_paths: ['tests/repro.test.ts'],
    });
    expect(info.files_changed).toEqual(['src/a.ts']);
  });
});

describe('harvest', () => {
  const spec = (impl: string, review: string, files: string[], changed: string[] = []) => ({
    from_worktree_abs: review,
    to_worktree_abs: impl,
    files,
    allowed_paths: ['tests/**', '**/__repro__/**'],
    max_files: 2,
    implementer_changed: changed,
    keep_dir_abs: join(repo.scratch, 'run/harvest'),
  });

  it('copies only named files under allowed paths', async () => {
    const impl = await make('impl');
    const review = await make('review-1');
    repo.write('tests/repro.test.ts', 'it fails', review);
    repo.write('src/a.ts', 'helpful fix nobody asked for', review);
    const r = harvest(spec(impl, review, ['tests/repro.test.ts']));
    expect(r).toEqual({ ok: true, files: ['tests/repro.test.ts'] });
    expect(readFileSync(join(impl, 'tests/repro.test.ts'), 'utf8')).toBe('it fails');
    expect(readFileSync(join(impl, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(existsSync(join(repo.scratch, 'run/harvest/tests/repro.test.ts'))).toBe(true);
  });

  it('refuses paths outside the allowlist, traversal, overlap, missing files and too many files', async () => {
    const impl = await make('impl');
    const review = await make('review-1');
    repo.write('tests/a.test.ts', 'x', review);
    repo.write('tests/b.test.ts', 'x', review);
    repo.write('tests/c.test.ts', 'x', review);
    expect(harvest(spec(impl, review, ['src/a.ts'])).ok).toBe(false);
    expect(harvest(spec(impl, review, ['../escape.ts'])).ok).toBe(false);
    expect(harvest(spec(impl, review, ['/etc/passwd'])).ok).toBe(false);
    expect(harvest(spec(impl, review, ['.conductor/out/x.json'])).ok).toBe(false);
    expect(harvest(spec(impl, review, ['tests/a.test.ts'], ['tests/a.test.ts'])).ok).toBe(false);
    expect(harvest(spec(impl, review, ['tests/missing.test.ts'])).ok).toBe(false);
    expect(harvest(spec(impl, review, ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'])).ok).toBe(false);
    expect(existsSync(join(impl, 'tests'))).toBe(false);
  });

  it('removes refuted reproductions and restores tampered ones', async () => {
    const impl = await make('impl');
    const review = await make('review-1');
    repo.write('tests/repro.test.ts', 'original', review);
    const s = spec(impl, review, ['tests/repro.test.ts']);
    harvest(s);
    writeFileSync(join(impl, 'tests/repro.test.ts'), 'weakened by the implementer');
    expect(restoreHarvested(impl, s.keep_dir_abs, ['tests/repro.test.ts'])).toEqual(['tests/repro.test.ts']);
    expect(readFileSync(join(impl, 'tests/repro.test.ts'), 'utf8')).toBe('original');
    expect(restoreHarvested(impl, s.keep_dir_abs, ['tests/repro.test.ts'])).toEqual([]);
    unharvest(impl, ['tests/repro.test.ts']);
    expect(existsSync(join(impl, 'tests/repro.test.ts'))).toBe(false);
  });
});

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OUT_DIR_REL, PACK_DIR_REL } from '../contracts/json-schema.js';
import { git } from '../git/exec.js';

const REFUSE = (what: string): string => `#!/bin/sh
echo "conductor: ${what} is not permitted in a conductor worktree. Leave your changes in the working tree." >&2
exit 1
`;

/**
 * Fires on every ref update made from a worktree, and unlike pre-commit it
 * cannot be skipped with --no-verify. Refusing in the "prepared" state aborts
 * the update, so HEAD, branches, tags and the shared refs never move.
 */
const REFERENCE_TRANSACTION = `#!/bin/sh
if [ "$1" = "prepared" ]; then
  echo "conductor: ref updates are not permitted in a conductor worktree. Leave your changes in the working tree." >&2
  exit 1
fi
exit 0
`;

/** Write the refusing hooks once per conductor home. Idempotent. */
export function ensureHooksDir(hooksDir: string): void {
  mkdirSync(hooksDir, { recursive: true });
  const hooks: Record<string, string> = {
    'pre-commit': REFUSE('committing'),
    'commit-msg': REFUSE('committing'),
    'pre-merge-commit': REFUSE('merging'),
    'pre-rebase': REFUSE('rebasing'),
    'pre-push': REFUSE('pushing'),
    'reference-transaction': REFERENCE_TRANSACTION,
  };
  for (const [name, body] of Object.entries(hooks)) {
    const file = join(hooksDir, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
}

export interface CreateWorktreeSpec {
  repo_abs: string;
  path_abs: string;
  base_sha: string;
  hooks_dir: string;
}

/**
 * A detached worktree at base_sha: there is no branch to advance. The
 * conductor's own directories ignore themselves, so a worker's `git status`
 * never shows them and no shared exclude file is touched.
 */
export async function createWorktree(spec: CreateWorktreeSpec): Promise<void> {
  if (existsSync(spec.path_abs)) throw new Error(`worktree path already exists: ${spec.path_abs}`);
  mkdirSync(dirname(spec.path_abs), { recursive: true });
  await git(spec.repo_abs, ['worktree', 'add', '--detach', spec.path_abs, spec.base_sha]);

  // Per-worktree config needs this extension. It is the one line the conductor
  // ever adds to the repository's shared config; `conductor doctor` reports it.
  const ext = await git(spec.repo_abs, ['config', '--get', 'extensions.worktreeConfig'], { allowFail: true });
  if (ext.stdout.trim() !== 'true') await git(spec.repo_abs, ['config', 'extensions.worktreeConfig', 'true']);
  await git(spec.path_abs, ['config', '--worktree', 'core.hooksPath', spec.hooks_dir]);

  resetConductorDirs(spec.path_abs);
}

/** (Re)create .conductor/pack and .conductor/out as empty, self-ignoring directories. */
export function resetConductorDirs(worktree: string, which: ('pack' | 'out')[] = ['pack', 'out']): void {
  for (const w of which) {
    const dir = join(worktree, w === 'pack' ? PACK_DIR_REL : OUT_DIR_REL);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.gitignore'), '*\n');
  }
}

export async function removeWorktree(repo_abs: string, path_abs: string): Promise<void> {
  if (!existsSync(path_abs)) return;
  const r = await git(repo_abs, ['worktree', 'remove', '--force', path_abs], { allowFail: true });
  if (r.code !== 0) rmSync(path_abs, { recursive: true, force: true });
}

export async function listWorktrees(repo_abs: string): Promise<string[]> {
  const r = await git(repo_abs, ['worktree', 'list', '--porcelain']);
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
}

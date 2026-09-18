import { git } from '../git/exec.js';

export interface GitSnapshot {
  head: string;
  /** refs/stash is shared by every worktree of a repo, so compare before/after rather than expecting empty. */
  stash_ref: string;
}

export interface AuditViolation {
  code: 'head_moved' | 'stash_changed' | 'index_dirty';
  /** fatal ⇒ the step is classified git_mutated and the run escalates. */
  severity: 'fatal' | 'warn';
  detail: string;
}

export async function snapshotGit(worktree_abs: string): Promise<GitSnapshot> {
  const head = (await git(worktree_abs, ['rev-parse', 'HEAD'])).stdout.trim();
  const stashRef = await git(worktree_abs, ['rev-parse', '-q', '--verify', 'refs/stash'], { allowFail: true });
  return { head, stash_ref: stashRef.code === 0 ? stashRef.stdout.trim() : '' };
}

/**
 * The last of the four layers in ADR-0008. Whatever the prompt, the command
 * policy and the refusing hooks did or did not stop, this reads the facts
 * after the worker has exited.
 *
 * A dirty index is a warning, not a violation: staging inside a throwaway
 * worktree harms nothing, and the patch is extracted through a separate index.
 */
export async function auditWorktree(worktree_abs: string, base_sha: string, before: GitSnapshot): Promise<AuditViolation[]> {
  const violations: AuditViolation[] = [];
  const after = await snapshotGit(worktree_abs);
  if (after.head !== base_sha) {
    violations.push({ code: 'head_moved', severity: 'fatal', detail: `HEAD is ${after.head}, expected ${base_sha}` });
  }
  if (after.stash_ref !== before.stash_ref) {
    violations.push({
      code: 'stash_changed',
      severity: 'fatal',
      detail: `refs/stash moved from ${before.stash_ref || '(none)'} to ${after.stash_ref || '(none)'}`,
    });
  }
  const staged = await git(worktree_abs, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (staged.code !== 0) {
    violations.push({ code: 'index_dirty', severity: 'warn', detail: 'the worker staged changes in its worktree index' });
  }
  return violations;
}

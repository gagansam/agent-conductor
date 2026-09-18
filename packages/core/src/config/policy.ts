import type { SandboxPolicy } from '@agent-conductor/adapter-api';
import type { RepoConfig } from './schema.js';

/**
 * Always denied, for every role, in every repo. A repo config can add to this
 * list and can never remove from it. See docs/adr/0008-git-non-mutation.md.
 */
export const GIT_MUTATION_DENYLIST: readonly string[] = [
  'git commit*',
  'git push*',
  'git add*',
  'git rm*',
  'git mv*',
  'git stash*',
  'git reset*',
  'git restore*',
  'git checkout*',
  'git switch*',
  'git rebase*',
  'git merge*',
  'git cherry-pick*',
  'git revert*',
  'git am*',
  'git tag*',
  'git branch*',
  'git worktree*',
  'git config*',
  'git clean*',
  'git gc*',
  'git update-ref*',
  'git remote*',
  'git fetch*',
  'git pull*',
];

/** Read-only git and basic inspection. Always allowed so a worker can orient itself. */
export const BASELINE_ALLOWED_COMMANDS: readonly string[] = [
  'git diff*',
  'git status*',
  'git log*',
  'git show*',
  'git blame*',
  'git ls-files*',
  'git grep*',
  'ls*',
  'cat*',
  'head*',
  'tail*',
  'wc*',
  'grep*',
  'rg*',
  'find*',
  'sed -n*',
  'pwd',
];

/**
 * Every role gets workspace-write in its OWN worktree. Reviewers and
 * reproducers write reproduction tests in a throwaway tree; only files named
 * in their output are ever harvested.
 */
export function buildPolicy(repo: RepoConfig): SandboxPolicy {
  const dedupe = (xs: readonly string[]): string[] => [...new Set(xs)];
  return {
    fs: 'workspace-write',
    network: repo.policy.network,
    allowed_commands: dedupe([...BASELINE_ALLOWED_COMMANDS, ...repo.policy.allowed_commands]),
    denied_commands: dedupe([...GIT_MUTATION_DENYLIST, ...repo.policy.denied_commands]),
    extra_readable_dirs_abs: [],
  };
}

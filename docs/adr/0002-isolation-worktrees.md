# ADR-0002 — Isolation: a detached git worktree per worker, outside the repo

**Status:** proposed · **Date:** 2026-09-07

## Context

Two agents must never write the same tree concurrently. The reviewer must
see the implementer's diff without its edits leaking anywhere. A crashed run
must leave something inspectable. Repos have heavy dependency directories
(`node_modules`, virtualenvs) that are gitignored.

## Decision

- Every worker gets its own worktree: `git worktree add --detach
  <~/.conductor/worktrees/<run>/<name>> <base_sha>`. Detached, so there is
  no branch to move.
- The implementer's worktree persists across rounds (its state is the work
  in progress). Each reviewer and reproducer gets a fresh worktree at
  `base_sha` with the implementer's patch applied via `git apply`, and the
  worktree is removed after harvest.
- Verification runs in the implementer's worktree after the implementer
  process has exited. Exactly one process writes a given worktree at any
  time, by construction of the round state machine.
- A `setup` hook from repo config runs after worktree creation and again
  when the diff touches lockfiles. On APFS, dependency directories may be
  cloned copy-on-write from the primary checkout (`cp -c`) as an
  optimization before `setup` runs.
- Harvest: from a reviewer's tree, only files named in the verdict, under
  `repro_allowed_paths`, not overlapping the implementer's changed files,
  copied into the implementer's worktree. Everything else is deleted with
  the worktree.
- Diff extraction goes through a throwaway index (`GIT_INDEX_FILE`): read
  `base_sha` into it, add everything, diff it against `base_sha`. New files
  are captured, gitignored files are not, and the worktree's real index is
  never touched, so nothing a worker staged can change the result.
  `.conductor/pack` and `.conductor/out` ignore themselves and are also
  excluded by pathspec. The patch file is the run's product.
- Crash handling: `state.json` per run holds the pid and heartbeat. Any
  conductor invocation reaps dead runs, releases their leases, marks them
  `crashed`, and keeps their worktrees until `gc` or `rm`. `git worktree
  prune` is run only on the conductor's own worktree paths.

Rejected: containers (per-repo build environment and vendor authentication
would both need to be reproduced inside; the vendor sandboxes already
provide the command-level containment that matters); full copies (slow for
large repos, lose git, though APFS cloning is kept as a dependency-dir
optimization); branches in the primary checkout (violates the constraint
outright).

## Consequences

- Fast creation, shared object store, standard git tooling for inspection.
- Gitignored files are absent; the repo config lists which to copy
  (`copy_untracked`) and the pack never includes them.
- Dependency setup time is on the critical path and must be measured per
  repo before milestone 1 ([11-risk-register.md](../11-risk-register.md) R4).
- Worktrees live outside the repository so no tool that globs the source
  tree ever sees them.

## Reopen when

A repo's verification cannot run outside a container (e.g. it needs
services only available in `docker compose`), at which point the worktree
is mounted into a container for verification only, and workers still run
on the host.

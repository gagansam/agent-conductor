# ADR-0008 — The conductor and its workers never mutate git history

**Status:** proposed · **Date:** 2026-09-07

## Context

Operator constraint, stated as non-negotiable: the orchestrator must never
commit, push, or otherwise mutate git history on the operator's behalf. It
stages nothing and leaves changes in the tree. Worker models will sometimes
try anyway; the operator already runs a hook in Claude Code that blocks
destructive git subcommands interactively.

## Decision

Four independent layers, all always on:

1. Worktrees are detached at `base_sha`; there is no branch to advance.
2. Command policy denies every history- and tree-mutating git subcommand
   (commit, push, stash, reset, restore, checkout, switch, rebase, merge,
   tag, branch deletion, worktree, config, clean). Where a vendor can
   enforce command policy (Claude Code tool allow/deny lists), it is passed
   as flags; where it cannot (Codex), the rule is stated in the prompt and
   layers 3 and 4 enforce it.
3. Each worktree's `core.hooksPath` (via `extensions.worktreeConfig`) points
   at conductor hooks. `reference-transaction` refuses every ref update and
   cannot be skipped with `--no-verify`; the commit and push hooks refuse too.
   Enabling `extensions.worktreeConfig` is the single line the conductor
   writes to the repository's shared config.
4. After every worker exits, the conductor audits the worktree: `HEAD` equals
   `base_sha` and the shared stash ref is unchanged. A violation classifies
   the step `git_mutated`, escalates the run, and preserves the worktree. The
   work is still extracted as a diff. A dirty index is only a warning.

The primary checkout is written only by `conductor apply <run>`, which uses
`git apply`, stages nothing (the `--3way` path runs against a throwaway
index, because `--3way` implies `--index` and would otherwise stage), refuses
to overwrite uncommitted changes to overlapping files, and records what it
applied and onto which commit.

The conformance suite's live tier asks each adapter's worker to commit and
push and asserts that nothing happened.

## Consequences

- The operator reviews and commits every change by hand, which is the
  point.
- A dangling commit made by a rogue worker in a detached worktree is
  harmless and is garbage-collected by git eventually; the audit still
  treats it as a violation so the corpus records which models do this.
- No feature in this project will ever need write access to a remote.

## Reopen when

Never. If the operator later wants an opt-in "commit to a branch" step, it
is a separate command run by the operator, not a step in the loop.

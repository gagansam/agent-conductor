# 09 — Trust and blast radius

## What a run can touch

| Thing | Implementer | Reviewer / reproducer | Verifier (conductor) |
|---|---|---|---|
| Its own worktree | read/write | read/write (throwaway) | read/write |
| Other worktrees | no | no | no |
| The primary checkout | **never** | **never** | **never** (only `conductor apply`) |
| `~/.conductor/runs/<run>/` | its log dir only, via the CLI's own logging | same | write |
| Vendor state dirs | the conductor-owned vendor home | same | — |
| Operator's vendor config (`~/.codex`, `~/.claude`) | read auth only, via symlink | same | — |
| Network | vendor API only; `curl`/`wget` denied; vendor sandbox off where available | same | as the repo's verification commands need |
| Git history (any repo) | **never** | **never** | **never** |

## The git rule, enforced four ways

The conductor must never commit, push, stage, or otherwise mutate history on
your behalf ([ADR-0008](adr/0008-git-non-mutation.md)). Worker models are
told this; the design assumes they will sometimes ignore it. (You already
enforce the same rule interactively: a `PreToolUse` hook on this machine
blocks destructive git subcommands in Claude Code's Bash tool. The conductor
extends that rule to every worker of every vendor.)

1. **Detached worktrees.** Every worktree is `git worktree add --detach
   <path> <base_sha>`. There is no branch to advance. A rogue `git commit`
   creates a dangling commit and moves the worktree's `HEAD`; it cannot
   touch any branch or the primary checkout's index.
2. **Command policy.** `denied_commands` always includes the history- and
   tree-mutating git subcommands: commit, push, stash, reset, restore,
   checkout, switch, rebase, merge, tag, branch deletion, worktree, config,
   and clean. Translated to `--disallowed-tools "Bash(git commit*)"` and so
   on for Claude Code. Codex's sandbox does not filter commands, so this
   rung is prompt-only there and the next two rungs carry the weight.
3. **Refusing hooks.** Each worktree's own config points `core.hooksPath` at
   a conductor directory. The hook that carries the weight is
   `reference-transaction`: it fires on every ref update and, unlike
   `pre-commit`, is not skipped by `--no-verify`. Refusing in the `prepared`
   state aborts the update, so `HEAD`, branches and tags cannot move from
   inside a worktree (tested, including with `--no-verify`). `pre-commit`,
   `commit-msg`, `pre-merge-commit`, `pre-rebase` and `pre-push` refuse too,
   for clearer messages. A worker can still defeat this by overriding
   `core.hooksPath` on the command line, which is what layer 4 is for.
   Per-worktree config requires `extensions.worktreeConfig = true` in the
   repository's shared config. That one line is the only thing the conductor
   ever writes to your repository's config; `conductor doctor` reports it.
   Your own hooks are untouched.
4. **Post-run audit.** After every worker exits: `HEAD` of the worktree must
   equal `base_sha` and the stash ref must be unchanged (it is shared by all
   worktrees of a repository, so it is compared before and after rather than
   expected to be empty). A dirty index is recorded as a warning only:
   staging inside a throwaway worktree harms nothing, and the patch is
   extracted through a separate temporary index so staging cannot change it.
   A fatal deviation classifies the step `git_mutated`, escalates the
   run, keeps the worktree for inspection, and is recorded against that
   provider in the corpus. The diff is still extracted (diff against
   `base_sha` plus untracked files) so the work is not lost.

The primary checkout is written by exactly one code path, `conductor apply
<run>`, which:

- refuses if the primary checkout has uncommitted changes to any file the
  patch touches (`--force` overrides, with a printed list),
- refuses if `HEAD` of the primary checkout is not `base_sha` unless
  `--3way` is given, in which case `git apply --3way` is used and conflicts
  are left as conflict markers for you,
- applies with `git apply` (never `git am`), stages nothing, commits nothing,
- records `applied_at` and `applied_to_sha` on the run.

## Sandbox story per vendor

The vendor-neutral `SandboxPolicy` is `{fs, network, allowed_commands,
denied_commands, extra_readable_dirs}`. Per role defaults:

| Role | fs | network | allowed_commands | notes |
|---|---|---|---|---|
| implementer | workspace-write | off | repo `policy.allowed_commands` (test/lint/build runners, read-only git, common shell utils) | the only role that produces the product |
| reviewer | workspace-write in its own throwaway tree | off | same | writes reproduction tests; everything else discarded |
| reproducer | same as reviewer | off | same | |

Translation (adapters own this; the table is illustrative and version-bound):

**Claude Code.** `-p --output-format stream-json --verbose`,
`--permission-mode acceptEdits`, `--allowed-tools` from the policy
(`Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash(<pattern>)` per allowed
command), `--disallowed-tools` for denied commands and for `WebFetch` and
`WebSearch`, `--setting-sources project` (drop the operator's user-level
settings and the global `CLAUDE.md`), `--settings <conductor json>`,
`--strict-mcp-config` with no MCP config (no MCP servers), `--max-turns` and
`--max-budget-usd` as caps. `bypassPermissions` is never used. The stricter
alternative for reviewers, `--restricted`, removes Bash entirely, which also
removes the reviewer's ability to run its own reproduction before submitting
it; the default is the allowlist, `--restricted` is a config switch.

**Codex.** `exec --json --skip-git-repo-check -s workspace-write` with
`CODEX_HOME=~/.conductor/vendor/codex-home` (auth symlinked, conductor
config.toml), `--ignore-user-config` and `--ignore-rules` where the version
has them, `-c approval_policy=never` where accepted, `-m <model_id>` always
explicit, `--output-schema <file>` where available. Network is off by
default in `workspace-write`. Codex has no per-command allowlist in the
probed versions, so command policy there is prompt plus hooks plus audit.
`--dangerously-bypass-approvals-and-sandbox` is never used.

The conformance suite's live tier asserts the important properties
(does not commit, stays in the tree, respects read-only) against the real
binaries, so a vendor that silently loosens a mode is caught on the next
`doctor --live` rather than in production
([04-worker-adapter-contract.md](04-worker-adapter-contract.md)).

## What is never permitted

- Commit, push, or any history mutation, by anyone, anywhere.
- Writing to the primary checkout except via `apply`.
- `bypassPermissions` / `--dangerously-bypass-approvals-and-sandbox`.
- Reading or writing the operator's vendor config files (auth is borrowed
  read-only via symlink).
- Any network call by the conductor itself. Workers reach their vendor API
  through the vendor CLI and nothing else.
- Sharing an account, proxying a subscription, or any multi-user mode. There
  is no config key for it and no code path.

## Kill switch

Three layers, any of which is sufficient:

1. **Ctrl-C** in the `conductor run` terminal: SIGTERM to every worker's
   process group, 10 s grace, SIGKILL; verification subprocesses likewise;
   run status `paused`; leases released; worktrees kept.
2. **`conductor kill [<run> | --all]`** from any terminal: reads pids from
   the database, same sequence, works even if the run's own process is
   wedged.
3. **`touch ~/.conductor/STOP`**: the dispatcher checks for the sentinel
   before every spawn and every verification step. Nothing new starts while
   it exists; running workers finish or hit their timeouts. Remove it to
   resume. This is the "I am walking away and I want the machine quiet"
   switch.

Hard ceilings independent of the switch: `max_wall_ms` per run,
`timeouts.total_ms` per worker, `timeout_ms` per verification step.

## Secrets

Verification commands may need `.env` files. Worktrees do not contain
gitignored files. The repo config can list `setup.copy_untracked:
[".env.test"]` to copy specific files from the primary checkout into each
worktree. They are never included in the pack, never in a diff, and the
paths are logged so you know what was copied. Workers can read them
(they are in the tree), which is the same exposure as running the CLI in
your repo by hand today.

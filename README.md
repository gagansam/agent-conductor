# agent-conductor

Orchestrate AI coding agents through local engineering workflows for implementation, review, testing, and validation.

A local, single-operator tool that drives the coding-agent CLIs you already use (Claude Code, Codex) through
one loop: **implement → verify → review → confirm → iterate**. Which model plays which role is a config line.

- **Verification is the only ground truth.** The conductor runs your checks itself and reads exit codes. A model
  saying "tests pass" is recorded as a claim.
- **Review findings must be executable.** A reviewer's finding is acted on only if the conductor can confirm it by
  running something: a failing test the reviewer wrote, a command, an acceptance check. Everything else is advice,
  and advice goes in the report, not the loop.
- **Isolation by construction.** Every worker gets its own detached git worktree. Reviewers write reproduction
  tests in a throwaway tree; only the files their verdict names are ever taken from it.
- **It never commits, stages or pushes.** Workers are blocked by command policy, refusing hooks and a post-run
  audit. The only write to your checkout is `conductor apply`, which applies a patch and stops.
- **Local-first.** State is SQLite plus files under `~/.conductor`. No telemetry, no server. Workers authenticate
  as the CLIs already do on your machine.

Status: the walking skeleton works end to end. See [docs/15-implementation-status.md](docs/15-implementation-status.md)
for what exists and what does not, and [docs/](docs/README.md) for the design.

## Quick start

Requires Node ≥ 22.13, pnpm, git, and at least one of `claude` / `codex` installed and logged in.

```sh
pnpm install && pnpm build
alias conductor="node $PWD/packages/cli/dist/bin.js"

conductor init --repo ~/code/myrepo   # asks for your defaults, writes both config files, then proves them
conductor doctor --live claude        # optional: two small prompts proving the adapter on your machine
```

`conductor init` writes `~/.conductor/config.yaml` (default implementer and reviewer) and the repository's
`.conductor/config.yaml`. It reads the repo's `package.json` / `pyproject.toml` / lockfiles, shows each detected
setup command, check and instruction file, and lets you keep, replace or remove it. It ends by running setup and
every check in a fresh worktree at `HEAD`, with no model calls, so you know runs will start from a green baseline.
`--yes` takes every default without asking; `conductor doctor --repo <path> --verify` repeats the proof later.

For a pnpm repo with `typecheck`, `lint` and `test` scripts, the generated `.conductor/config.yaml` is
(comments trimmed; [reference](docs/14-config-reference.md)):

```yaml
version: 1
setup:
  run: "pnpm install --frozen-lockfile --prefer-offline"   # from pnpm-lock.yaml
  timeout_ms: 600000
verification:                                              # the definition of done, in order
  - id: "typecheck"
    kind: typecheck
    run: "pnpm run typecheck"   # from package.json scripts.typecheck
    timeout_ms: 600000
    parse: tsc
  - id: "lint"
    kind: lint
    run: "pnpm run lint"   # from package.json scripts.lint
    timeout_ms: 600000
  - id: "test"
    kind: test
    run: "pnpm run test"   # from package.json scripts.test
    timeout_ms: 1200000
repro:
  allowed_paths: ["tests/**", "**/__repro__/**"]           # where a reviewer may add failing tests
instructions:
  sources:
    - "AGENTS.md"                                          # committed markdown given to every worker
policy:
  network: false
  allowed_commands:                                        # what Claude workers may run
    - "pnpm run typecheck*"
    - "pnpm run lint*"
    - "pnpm run test*"
    - "pnpm exec vitest*"
    - "pnpm exec tsc*"
    - "node *"
```

Commit it, or keep it local: `init` offers to add `.conductor/` to the clone's local exclude file. Runs read it
from your working copy either way.

Write a task ([format](docs/03-contracts.md#8-example-a-task-file)):

```markdown
---
title: Add "archive" action to project list
acceptance:
  - id: AC1
    text: Archived projects are excluded from the default list query
    check: { kind: test, run: "pnpm vitest run src/projects/list.test.ts" }
touch_hint: ["src/projects/**"]
---
Users need to archive projects without deleting them. Follow the pattern in `src/projects/favorite.ts`.
```

Run it:

```sh
conductor run task.md --repo ~/code/myrepo
conductor run task.md -i claude/opus:high -r codex/default   # pick implementer / reviewer for this run
conductor run task.md -r none                                # implement → verify only, no review
conductor list            # every run, across repos
conductor show            # rounds, workers, checks, findings with their confirmation status
conductor apply           # patch onto your checkout; nothing staged, nothing committed
```

A run first proves your checks pass on the untouched base commit, and stops with no quota spent if they do not.
With a red baseline an implementer ends up repairing (or gaming) your checks instead of doing the task.

## Development

```sh
pnpm typecheck && pnpm test && pnpm build
```

Tests never call a vendor CLI: the engine is driven by a scripted adapter against temporary git repositories, and
the real adapters are checked against recorded output. [AGENTS.md](AGENTS.md) has the conventions, including the
one boundary rule: vendor knowledge lives only in `packages/adapter-<vendor>`.

Writing an adapter for another CLI: [docs/04-worker-adapter-contract.md](docs/04-worker-adapter-contract.md).

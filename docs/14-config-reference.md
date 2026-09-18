# 14 — Configuration reference (v1)

Two files. Global config is about providers and roles; repo config is about
how to verify and what workers may do. Model ids appear in exactly one
place: `providers.<p>.models`, as label → opaque vendor string.

## `~/.conductor/config.yaml`

```yaml
version: 1

providers:
  claude:
    adapter: "@agent-conductor/adapter-claude"
    binary: claude                      # or an absolute path
    max_concurrent: 1                   # a quota decision, not a process-count decision
    reserve_utilization: 0.85           # do not dispatch above this five-hour utilization
    models:                             # labels → whatever the CLI accepts today; "" = the CLI's own default
      strong: opus
      fast: sonnet
      default: ""
  codex:
    adapter: "@agent-conductor/adapter-codex"
    binary: /Users/me/.npm-global/bin/codex   # or /Applications/Codex.app/Contents/Resources/codex
    max_concurrent: 1
    models:
      strong: gpt-5-codex               # placeholder; edit when the vendor renames

roles:
  implementer:
    provider: claude
    model: strong
    effort: high                        # dropped silently if the adapter lacks effort_select
    fallback:
      - { provider: codex, model: strong }
  reviewer:
    provider: codex
    model: strong
  reviewer_2:                           # a second reviewer; first thing dropped under quota pressure
    provider: claude
    model: strong
    optional: true
  reproducer:
    provider: codex
    model: strong

loop:
  max_rounds: 3
  max_fix_attempts_per_round: 2
  max_worker_runs: 8
  max_wall_ms: 2700000                  # 45 min
  max_reviewers: 1
  idle_timeout_ms: 600000               # no events / no file activity for 10 min ⇒ kill
  worker_total_timeout_ms: 1800000      # 30 min per worker invocation
  max_quota_wait_ms: 900000             # wait up to 15 min for a cooling provider before pausing
  require_cross_vendor_review: warn     # enforce | warn | off
  verify_baseline: true                 # run the repo's checks on the untouched base commit first; abort if red

gates:
  default: [before_apply]               # after_reproduce | after_implement | after_review | before_apply

notify:
  macos_notification: true
  bell: true
  hook: ""                              # optional shell command; receives run id and event as args

paths:
  home: ~/.conductor                    # db, runs, worktrees, vendor homes live here
```

## `<repo>/.conductor/config.yaml`

Written by `conductor init --repo <path>`, which detects setup, checks, test
directories and instruction files from the repo's manifests and asks about
each one; `conductor doctor --repo <path> --verify` then runs setup and every
check in a fresh worktree at `HEAD` without calling a model. The file can be
committed or kept local (init offers to add `.conductor/` to the clone's
local exclude file); runs read it from your working copy either way. The
example below shows every key; generated files use a subset.

```yaml
version: 1

setup:
  run: pnpm install --frozen-lockfile --prefer-offline
  rerun_if: ["pnpm-lock.yaml", "package.json"]
  clone_dirs: ["node_modules"]          # APFS copy-on-write from the primary checkout before `run`
  copy_untracked: [".env.test"]         # gitignored files workers and verification need; logged, never in the pack
  timeout_ms: 300000

verification:
  - id: typecheck
    kind: typecheck
    run: pnpm tsc --noEmit
    required: true
    timeout_ms: 300000
    parse: tsc
  - id: lint
    kind: lint
    run: pnpm eslint . -f json -o .conductor/out/eslint.json
    required: true
    timeout_ms: 300000
    parse: eslint-json
    artifacts: [".conductor/out/eslint.json"]
  - id: unit
    kind: test
    run: pnpm vitest run --reporter=junit --outputFile=.conductor/out/junit.xml
    required: true
    timeout_ms: 900000
    parse: junit
    report_path: .conductor/out/junit.xml   # where the parser reads from; falls back to stdout
  - id: e2e
    kind: browser
    run: pnpm playwright test --reporter=junit
    required: false                     # cannot block a round until services hooks exist (M5)
    timeout_ms: 1200000
    parse: junit

repro:
  allowed_paths: ["src/**/__repro__/**", "tests/**", "e2e/**"]
  max_files: 5

instructions:
  sources:
    - AGENTS.md
    - docs/invariants/**/*.md
    - .claude/skills/verify-change/SKILL.md
    - .claude/skills/expert-review/SKILL.md
    - .claude/skills/implement-feature/SKILL.md
    - .claude/skills/fix-bug/SKILL.md

policy:
  network: false
  allowed_commands:
    - "pnpm test*"
    - "pnpm vitest*"
    - "pnpm tsc*"
    - "pnpm eslint*"
    - "pnpm build*"
    - "pnpm playwright*"
    - "node *"
    - "git diff*"
    - "git status*"
    - "git log*"
    - "git show*"
    - "git blame*"
    - "ls*"
    - "cat*"
    - "grep*"
    - "rg*"
    - "find*"
    - "sed -n*"
  denied_commands:                      # merged with the built-in git-mutation denylist; cannot remove entries from it
    - "curl*"
    - "wget*"
    - "rm -rf*"

routing:                                # optional per-repo override of global roles
  reviewer: { provider: codex, model: strong }

templates: .conductor/templates         # optional overrides of implementer.md / reviewer.md / reproducer.md
```

## Resolution order

Global roles → repo `routing` → task `routing` → `conductor run` flags. Global loop → task `budget`.

The flags take `<provider>/<model>[:<effort>]`:

```sh
conductor run task.md --implementer claude/opus:high --reviewer codex/default
conductor run task.md -i claude/claude-fable-5 -r none      # raw model id; no review round
```

`<model>` is a label from `providers.<p>.models`, or, if it is not one, passed to
the CLI verbatim as a model id (with a note), so a new model version needs no
config edit. Omitting `:<effort>` keeps the configured effort when the provider
is unchanged and drops it otherwise, since effort values are vendor-specific.
`--reviewer none` sets `max_reviewers` to 0. The flags are written into the
stored task's `routing`, so `conductor show --json` records what actually ran.
Repo verification → task `verification.add` and `verification.disable`.
Repo policy is not overridable per task; loosening it is a repo decision.

## Backend example (Python / Starlette)

```yaml
setup:
  run: uv sync --frozen
  rerun_if: ["uv.lock", "pyproject.toml"]
  clone_dirs: [".venv"]
verification:
  - { id: typecheck, kind: typecheck, run: "uv run mypy .", required: true, timeout_ms: 300000, parse: none }
  - { id: lint, kind: lint, run: "uv run ruff check . --output-format json > .conductor/out/ruff.json", required: true, timeout_ms: 120000, parse: none }
  - { id: unit, kind: test, run: "uv run pytest -q --junitxml=.conductor/out/junit.xml", required: true, timeout_ms: 900000, parse: junit }
repro:
  allowed_paths: ["tests/**"]
policy:
  allowed_commands: ["uv run *", "python *", "git diff*", "git status*", "git log*", "ls*", "cat*", "grep*", "rg*", "find*"]
```

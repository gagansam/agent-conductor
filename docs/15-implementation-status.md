# 15 — Implementation status

Last updated 2026-09-18. This document says what exists, what the first live
runs showed, and where the code departs from the design documents. Where a
design document was simply wrong, it has been corrected in place and the
correction is listed here.

## What exists

Milestone 1 (the walking skeleton in [10-milestones.md](10-milestones.md)) is
built, plus the parts of milestone 2 that came almost free once the pieces
existed. 99 tests pass (`pnpm test`); `pnpm typecheck` and `pnpm build` are
clean.

| Package | State |
|---|---|
| `adapter-api` | Contract types; `spawnCli` / `runCliWorker` / `ArgvBuilder`; tier-1 offline conformance (10 assertions per fixture and per version); tier-2 live conformance (12 assertions, 2 prompts), with a sanitizing fixture recorder |
| `adapter-fake` | Scripted adapter. Drives every engine test |
| `adapter-claude` | Detect, capability probe from `--help`, argv with droppable optional flags, stream-json parser, classifier. **Passes live conformance on 2.1.263** |
| `adapter-codex` | Same, for both JSONL dialects (0.3x `{id,msg}` and 0.1xx thread/turn/item), isolated `CODEX_HOME` with symlinked auth. Passes offline conformance on 0.36.0 and 0.145.0. **Live success path not yet verified** |
| `core` | zod contracts + JSON Schema export; config and task parsing; worktree isolation with refusing hooks; temp-index patch extraction; harvest with tamper restore; audit; pack rendering with instruction inlining and lint; verifier with junit / tsc / eslint parsers; confirmer; dispatcher with DB leases, supervision and two retry policies; SQLite store (full schema from doc 07); the round engine |
| `cli` | `init` (interactive: global defaults, then per-repo config detected from manifests and confirmed question by question), `doctor` (`--live`, `--record`, `--verify`), `run` (with `-i/--implementer`, `-r/--reviewer` role overrides), `list`, `show`, `apply` |

Engine behaviour that is implemented and tested: baseline verification,
the clarify turn (questions before coding, answers as binding decisions),
mid-work stops for blocking questions with resume in the same session, the
checkpoint for the implementer's own choices before review (with overrules
sent back as fixes), bounded waiting for answers, setup artifacts kept out of
the patch,
fix sub-rounds while verification is red, review only on green, parallel
reviewers in throwaway worktrees, confirmation of `test` / `command` /
`acceptance` / `none` reproductions, harvested reproductions joining the
verification plan, debt and the strict monotonic-progress rule,
`regression_of` escalation, repair turns (resumed when the adapter can),
resumed implementer sessions across fix attempts and rounds, tamper restore
of harvested files, all budgets, cross-vendor policy (`enforce | warn | off`),
interactive gates, operator abort (Ctrl-C kills process groups), the `STOP`
sentinel, git-mutation escalation with the work still saved as a patch, and
failing reproductions of open findings kept out of the final patch.

## What the live runs showed

### 1. The loop works end to end with real workers

A toy task (make `slugify` robust) ran through `conductor run` with Claude
Code as implementer and, since the Codex live path was not yet verified,
Claude also as a same-vendor reviewer: implement → verify (red) → resumed fix attempt → verify
(green) → review in a throwaway worktree → verdict validated against the
schema on the first attempt → confirm → converged. Three worker runs,
5.6 minutes. `conductor apply` then put three files into the toy checkout,
unstaged, with `HEAD` unmoved; a second apply was refused.

Settings isolation is confirmed: the worker's `init` event reported
`mcp_servers: []` and `plugins: []`, where an un-isolated headless run on the
same machine loads three MCP servers.

### 2. A red baseline turns the loop into a test-gaming machine

The important finding. The toy repo's check (`node --test test/`) was wrong
for Node 26 and **failed at the base commit**, before any change. The
implementer's first pass was fine; verification was red for a reason that had
nothing to do with it; the fix attempt then made the check pass by deleting
`test/slug.test.js` and recreating its contents as `test/index.js`, a path the
broken command happened to resolve. The reviewer approved. Every component
behaved as designed and the output was a hack to satisfy a broken gate.

Consequences, all implemented:

- **Baseline verification** ([05-loop-control.md](05-loop-control.md)): the
  repo's checks run on the untouched base commit first; red aborts the run
  with zero quota spent. Re-running the same task now stops in 0.1 s with
  "verification is already red at the base commit (unit)".
- **Deleted files are always surfaced** in the run output and `PatchInfo`.
- Risk R4 in [11-risk-register.md](11-risk-register.md) was rated below
  vendor churn. It should be read as equal first: it is the failure that
  produces *confidently wrong output*, where churn merely produces errors.

It is one data point, and the reviewer was same-vendor. It is still the kind
of thing the corpus exists to count.

### 3. Codex: exit codes, the usage-limit signal, and config pollution

- Codex has no quota telemetry in `exec --json`. A usage limit arrives only as
  an `error` event with a human-readable reset time. The adapter classifies it
  `rate_limited` from the event stream and parses the message into a
  `rate_limit` event whose reset time is stored as the provider's
  `cooling_until`.
- Codex 0.145 exits **1** on a failed turn; 0.36 exited **0**. Classification
  reads the stream in both cases (a recorded fixture for 0.36, a unit test for
  0.145).
- Codex writes `[projects."<path>"] trust_level = "trusted"` entries into
  whatever `config.toml` its home contains, one per directory it runs in. With
  the operator's real home that would have added a throwaway worktree path to
  `~/.codex/config.toml` on every worker run. ADR-0009 (isolated vendor home)
  was justified on parse errors; this is a second, independent reason.
- `conductor init` found two Codex binaries (npm 0.36.0, app bundle 0.145.0)
  and chose the newer by version, which resolves open question Q1 without an
  install.

### 4. Smaller things

- The Codex adapter first built `exec resume <id> --json …`. On 0.36 that is
  a usage error: `exec resume` there accepts only `-c` and `--last`. Every
  flag now goes before `resume`, which parses on both versions. Found by
  reading `--help` for a claim I was about to write down, then confirmed
  against both binaries. The dispatcher's two retry policies
  (drop optional flags; retry a failed resume in a fresh session) now compose
  instead of excluding each other, so a future change in resume syntax
  degrades to a fresh session rather than a failed step.

- Cache reads were more than 95% of input tokens. Reporting them inside
  `input_tokens` made a toy task read as 1.07 M tokens in. They are now
  separate (`cached_input_tokens`).
- `--max-turns` no longer appears in `claude --help` on 2.1.263, eleven days
  after the design session listed it. The adapter never depended on it.
- `git apply --3way` implies `--index` and would have staged files in the
  operator's checkout. `apply --3way` now runs against a throwaway index.

### 5. One unexplained test failure

During the session `pnpm test` reported 1 failure in 59 once, immediately
after a full typecheck, and then passed on every rerun; the failing output was
not captured. The only clock-dependent assertion in the suite was the
operator-abort test, which aborted on a 200 ms timer and indexed the first
worker row: under load, worktree setup can outlast the timer, leaving no row.
That test now aborts on the `worker_started` event, and the abort-before-any-
worker path has its own test. The suite then passed three times with a
typecheck running concurrently. The cause is inferred, not proven. If a
failure recurs, capture it: `pnpm test 2>&1 | tee test.log`.

### 6. The clarify step, live

Two runs of the same deliberately ambiguous task ("add `divide(a, b)`", with
division by zero left unspecified) on a sample repo, Claude Sonnet as
implementer.

- **First prompt: no question.** The clarify turn decided the code's
  convention (no input validation) answered it, then the implementer listed
  division by zero under `open_questions` *after* doing the work: the exact
  failure the step exists to prevent. The prompt now says unspecified edge
  cases count even when the code suggests a convention, which becomes the
  proposed default.
- **Second prompt: the right question.** "How should `divide(a, b)` behave
  when b is 0?", with options and the convention as default. Answered at the
  terminal with "throw a RangeError"; the resumed implementer (same session
  id) implemented and tested exactly that; converged in 1.7 minutes.
- **A real bug the first run exposed:** `conductor init` offers to add
  `.conductor/` to the clone's local exclude file, and `git add` refuses a
  pathspec naming an ignored path, so every run on such a repo crashed at
  patch extraction. The redundant pathspecs are gone and a regression test
  covers it.

### 7. Asking mid-work, live

Two runs of a task that does not say which of two arithmetic modules
(`lib/math.js` for billing, `src/calc.js` for reporting) should get a new
`divide`, with `--no-clarify` so the question could only come up mid-work.

- **First prompt: it hedged.** The implementer noticed the ambiguity, wrote
  its choice as a question, then added `divide` to *both* modules and recorded
  that as a small choice. The checkpoint still showed it before review, so it
  could have been overruled, but it should have been a stop. The prompt now
  says hedging is the signal to stop.
- **Second prompt: it stopped.** "Should divide(a, b) go in lib/math.js
  (billing) or src/calc.js (reporting)?", with options and a recommendation;
  resumed in the same session after the answer, then recorded two small
  choices. Overruling the division-by-zero one sent it back as a fix; the
  result threw `RangeError` as decided. Work, answer and fix turns shared one
  session id; converged in under two minutes.
- **A leak the run exposed:** the sample repo had no lockfile, so setup's
  `npm install` wrote one, and it ended up in the patch as if the implementer
  had written it. The engine now records what setup changed and keeps those
  files out of every patch while they are still as setup left them.

## Where the code departs from the design documents

Corrected in place in the named document:

| Topic | Design said | Code does | Why |
|---|---|---|---|
| Hiding `.conductor/` ([02](02-component-map.md), [ADR-0002](adr/0002-isolation-worktrees.md)) | list it in `info/exclude` | the two directories carry their own `.gitignore` | `info/exclude` is shared with the primary checkout and would hide the tracked repo config |
| Refusing hooks ([09](09-trust-and-blast-radius.md), [ADR-0008](adr/0008-git-non-mutation.md)) | `pre-commit`, `commit-msg`, `pre-push` | those plus `reference-transaction` | `--no-verify` skips the first two; nothing skips a ref transaction |
| "Does not touch the primary config" (09) | claimed | false: `extensions.worktreeConfig = true` is written once | per-worktree `core.hooksPath` needs it. Documented and reported by `doctor` |
| Audit: index must be empty (09) | fatal | warning | staging in a throwaway tree is harmless and the patch ignores the index |
| Audit: stash list empty (09) | expected empty | compared before/after | the stash ref is shared across worktrees; yours would trip it |
| Patch extraction (ADR-0002) | diff plus untracked files | throwaway index | one mechanism for new files, ignores and binary; immune to worker staging |
| Who loads adapters ([02](02-component-map.md)) | `core`, by dynamic import | the CLI; `core` receives instances | module resolution from `core` would require `core` to depend on adapters |
| `adapter-api` is types only ([04](04-worker-adapter-contract.md)) | yes | also ships the process helper | process-group and event-ordering guarantees belong in one place |
| Baseline check ([05](05-loop-control.md)) | absent | present, default on | finding 2 above |

Not yet corrected because the design still stands and the code is behind:

- `setup.rerun_if` is parsed and ignored; setup runs once per worktree.
- The idle timeout watches events only. There is no file-activity heartbeat,
  so a worker sitting in one silent ten-minute test run would be killed. Raise
  `loop.idle_timeout_ms` for repos with slow suites until it exists.
- No quota gate. `provider_state` (utilization, `cooling_until`) is recorded
  on every run and nothing reads it yet. A rate-limited step escalates the run
  as `quota_exhausted` instead of pausing it.
- No `resume`, `kill`, `tail`, `gc`, `rm`, `stats`, `annotate`, `export`.
  A closed terminal ends the run; worktrees and run directories accumulate
  under `~/.conductor` until removed by hand (`git worktree remove`).
- No `reproducer` step in the loop (the role, prompt and schema exist).
- `sandbox_violation` (writes outside the worktree) is not detected.
- Live conformance covers 5 of the 11 assertions in doc 04: not yet read-only,
  canary outside cwd, kill, idle timeout, resume.
- Native structured output (`--json-schema`, `--output-schema`) is detected
  and off. The file protocol validated first time in every live run so far;
  turn it on per provider with `options.native_structured_output: true` when
  the corpus says repair turns are costing quota.

## What to do next, in order

1. **Verify Codex live:** `conductor doctor --live codex --record
   packages/adapter-codex/fixtures`. That is the one unverified success path.
2. **M0 is still owed.** The engine existing does not answer whether
   cross-vendor review yields *confirmed* findings on real diffs. Now it is
   cheap to measure: run real tasks and read `conductor show`.
3. Write `.conductor/config.yaml` for the frontend and backend repos (open
   question Q3) and run `conductor doctor --repo` on each. Then one real,
   small task per repo with the default gates on.
4. Then M2's remainder: `resume` / `kill`, file-activity heartbeat,
   `rerun_if`, the reproducer step, quota pause-and-resume.

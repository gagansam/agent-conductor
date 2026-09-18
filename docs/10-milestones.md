# 10 — Milestones

> **Status, 2026-09-18:** M1 is built and has run end to end against the real
> Claude Code CLI; much of M2's loop logic came with it. M0 is still owed. See
> [15-implementation-status.md](15-implementation-status.md).

Each milestone ends with a go/no-go question. The point of the sequence is
to spend as little as possible before the question that could kill the
project is answered.

## M0 — The verdict experiment (no orchestrator code)

**Goal:** find out whether cross-vendor review of your diffs produces
*confirmed* findings, before building a loop around it.

**Do:**
1. Write the reviewer prompt template and the `Verdict` JSON Schema from
   [03-contracts.md](03-contracts.md).
2. Pick 8–10 real diffs from recent work (a mix of features and bug fixes,
   some you know had defects).
3. For each, in a throwaway worktree, run the reviewer by hand: Codex
   (`codex exec --output-schema verdict.schema.json` on the bundled binary)
   and, separately, Claude (`claude -p --json-schema`) — same prompt.
4. Run every reproduction by hand. Count: findings, findings with
   reproductions, reproductions that confirm, refuted, advice.
5. Also do the cheap in-Claude-Code version: a skill that shells out to
   `codex exec` for review, to feel the friction.

**Go/no-go:** if fewer than one confirmed finding per three diffs across
both reviewers, the loop is not the product. Build M1 without the review
round (implement → verify → report) and revisit review as an optional pass.
If confirmed findings are common, proceed as designed.

**Effort:** one or two evenings. **Prerequisite:** a working Codex CLI
([12-open-questions.md](12-open-questions.md) Q1).

## M1 — Walking skeleton

**Goal:** one task, one implementer, one reviewer, real verification, real
confirmation, real persisted trace, on one of your repos.

```
conductor doctor                      detect both CLIs, probe capabilities, check repo config, check CLAUDE.md import
conductor run task.md                 the loop, ONE round, no iteration
conductor show <run>                  round record, findings with confirmation, paths
conductor apply <run>                 patch onto the primary checkout, no staging
```

**Contains:**
- `adapter-api` with the types and the tier-1 conformance harness.
- `adapter-fake`: scripted; applies a canned patch and writes a canned
  output file; used by every core test.
- `adapter-claude` (implementer) and `adapter-codex` (reviewer), each with
  `detect`, `capabilities`, `start`, event parsing for the versions on this
  machine, classification, and recorded fixtures.
- `core`: contracts (zod + JSON Schema export), config loading, task parsing,
  worktree isolation with setup hook and `.conductor/` exclusion, pack
  rendering with instruction inlining, dispatcher with leases and
  classification (retry policies limited to the optional-flag drop and one
  repair turn), verifier with junit parsing, confirmer for `test` and
  `command` reproductions including harvest, engine for exactly one round,
  SQLite store with the full schema, git non-mutation hooks and audit.
- `cli`: the four commands above.

**Explicitly not in M1:** rounds > 1, fix sub-rounds, gates other than
`before_apply`, `reproducer` role, second reviewer, quota gating, backoff
ladder, `resume`, `kill` (Ctrl-C only), `tail`, `stats`, web view, prune/gc,
browser verification.

**Go/no-go:** run it on three real tasks. Does the confirmed-findings rule
hold up with the conductor doing the confirmation? Is setup time in a fresh
worktree acceptable for your repos? Is usage per task compatible with your
plan windows (read the `rate_limit_event` data)? If any of these is bad, fix
it before adding rounds.

## M2 — The loop

Rounds, fix sub-rounds, debt and monotonic progress, escalation reasons,
`regression_of` handling, harvested tests joining the verification plan,
repair turns with resume, all gates, `conductor resume`, `conductor kill`,
`STOP` sentinel, orphan detection, `gc`/`rm`, the `bugfix` workflow with the
`reproducer` role. Timeouts, idle detection, classification retry table in
full. Tier-2 live conformance.

**Go/no-go:** five tasks end to end without you touching a worker. Escalations
are correct (you agree with why it stopped) at least four times out of five.

## M3 — Two providers under pressure

Second reviewer (parallel, own worktree), degradation ladder, quota gating
from observed signals, cooling and backoff, `waiting_quota` with resume,
multiple `conductor run` processes sharing leases, notifications. Probe
whether newer Codex emits any rate-limit signal in `exec --json`; if it
does, wire it.

**Go/no-go:** deliberately run into the Claude five-hour window mid-task.
The run pauses and resumes; nothing fails; the trace explains it.

## M4 — The corpus is usable

`annotate`, `stats` (the canned queries in
[07-state-and-corpus.md](07-state-and-corpus.md)), `export --jsonl --redact`,
instruction lint in `doctor`, `prune`. First honest answer to "does
cross-vendor review beat same-vendor review on my code": run five tasks
with `same_vendor_review` deliberately on and compare.

**Go/no-go:** the stats change a routing line, or they show routing does not
matter yet. Either is a result.

## M5 — Seeing it

`conductor serve` / `conductor show --web`: a read-only local page over the
database: diff with findings anchored to lines, round timeline, confirmation
status, verification logs, the corpus tables. No editing, no approvals in
the browser in this milestone (gates stay in the terminal), no daemon.
Browser verification as an ordinary verification step with a `services`
up/down hook in repo config if your e2e needs a running backend.

**Go/no-go:** you stop opening the worktree in an editor to understand a
verdict.

## M6 — Hardening for contributors

Weekly CI job that runs tier-1 conformance against fixtures and, on a
self-hosted runner or manually, tier-2 against the latest vendor releases.
Adapter authoring guide. A third adapter written by someone (or you,
pretending) who has not read `core`, to prove the contract. Only after this
is the repo advertised.

## What to build first, precisely

The first commit after this design should be `adapter-api` types plus the
`adapter-fake`, then the `core` contracts with tests that round-trip the
example task and verdict from [03-contracts.md](03-contracts.md), then
isolation (worktree create, setup, diff, harvest, audit) with tests against
a temp git repo. Only then the real adapters. The real adapters are the
part most likely to need rewriting; everything before them should be
solid when that happens.

# 11 — Risk register

Ordered by how likely each is to end the project. Each has the cheapest
experiment that would expose it, and the milestone where that experiment
lives.

## R1 — Vendor churn eats the project (technical, near-certain)

**Evidence:** between the two Codex versions on this machine the JSON event
format was replaced, an `exec` flag was removed, a raw-protocol command was
renamed, a config enum gained a value the older binary hard-errors on, and
the desktop app writes a config file the npm CLI cannot parse
([13-environment-findings.md](13-environment-findings.md)). The installed
npm CLI is 117 minor versions behind the latest. Claude Code is at 2.1.258
and ships weekly.

**Mitigation:** the narrow contract and the file protocol
([ADR-0006](adr/0006-files-are-the-interface.md)); every optional flag
droppable; capability probing per version with cached results; conductor-
owned vendor homes ([ADR-0009](adr/0009-vendor-config-isolation.md));
recorded fixtures per version so tier-1 conformance keeps old parsers
honest; adapters treated as disposable.

**Falsifying experiment (M6, but start the clock in M1):** a weekly CI run of
tier-1 conformance plus a manual tier-2 run against the latest vendor
releases. If an adapter breaks more than once a month *despite* the narrow
contract, the tax is too high for a single maintainer and the honest answer
is to freeze one vendor version per adapter and only bump deliberately.

## R2 — Review does not produce confirmed findings (was never worth building)

**The claim at risk:** cross-vendor review of your diffs yields findings a
machine can confirm. If reviewers mostly produce advice, the loop adds
quota cost and wall time without changing outcomes, and the project
collapses to "implement, verify, report", which is a shell script.

**Mitigation:** the executable-findings rule makes this measurable from the
first run; `needs_human` carve-outs keep the rare high-value unconfirmable
finding from being lost.

**Falsifying experiment (M0):** ten real diffs, two reviewers, count
confirmed reproductions. Threshold: fewer than one confirmed finding per
three diffs means review is optional, not the loop's spine. This is the
cheapest and most important experiment in the plan and it needs no
orchestrator code.

## R3 — Quota makes it unusable (constraint-driven)

**The arithmetic:** a three-round task with one reviewer is up to eight CLI
invocations, each with a large pack. Two such tasks in a five-hour window
may exhaust a plan. The probes showed Claude's five-hour window at 23%
utilization from ordinary interactive use before any orchestration.

**Mitigation:** default one reviewer and three rounds; review skipped while
verification is red; observed-utilization gate for Claude; pause-not-fail;
the degradation ladder; usage per run recorded so defaults can be tuned
from data.

**Falsifying experiment (M1):** run three real tasks and read the
`rate_limit_event` deltas. Compute tasks per window per plan. If it is
under three, cut defaults to one round of review and make the second round
opt-in, and put "which plan tier" in the setup docs as the first question.

## R4 — Verification in a fresh worktree is slow or flaky

**Why it matters:** verification is the only ground truth. If a fresh
worktree needs a five-minute install or the e2e suite needs a running
backend and a seeded database, the "facts" become slow, flaky, or skipped,
and the loop reverts to opinions.

**Mitigation:** `setup` hook with rerun-on-lockfile-change; APFS
copy-on-write cloning of dependency directories from the primary checkout
on macOS (`cp -c`) as an optimization; `copy_untracked` for env files;
`services` up/down hooks in M5; required vs optional steps so a flaky e2e
does not block a round.

**Falsifying experiment (before M1):** by hand, create a worktree of each
repo, run its setup and full verification, time it, repeat three times. If
setup exceeds two minutes or the suite is not deterministic, fix the repo's
scripts first. This is repo work, not conductor work, and it is on the
critical path.

## R5 — The effort trap: you go back to driving by hand

**Shape:** the conductor works, but the pack is worse than what you type,
or escalations are wrong often enough that you stop trusting them, and
within a month you are running the loop manually again while maintaining
an orchestrator nobody uses.

**Mitigation:** the pack is your skills verbatim; gates are cheap to enable;
every milestone has a go/no-go stated in terms of your behavior ("you stop
opening the worktree in an editor"); M0 and M1 are small enough to abandon
without regret.

**Falsifying experiment (M2 go/no-go):** five tasks without touching a
worker, and you agree with four of five escalations. If not, the problem is
almost always the prompt templates or the acceptance criteria, both of which
are data, not code.

## R6 — Codex on this machine is currently non-functional for this account

**Evidence:** every model tried on 0.36.0 is rejected with a ChatGPT-account
error; the bundled 0.145.0 works. Until the npm package is updated or the
config points at the bundled binary, only one vendor exists, and the
walking skeleton cannot exercise cross-vendor review.

**Mitigation:** `doctor` detects the state and prints the fix; the adapter
records rejected model ids per version so the same dead end is not retried.

**Experiment:** none needed; it is a decision
([12-open-questions.md](12-open-questions.md) Q1).

## R7 — Workers subvert the sandbox or the git rule

**Shape:** a worker commits, stashes, edits outside its tree, or modifies a
harvested reproduction to make it pass.

**Mitigation:** four-layer git rule; post-run audit; harvested files
restored from the run dir before verification and modification flagged
`tampered`; canary and no-commit assertions in tier-2 conformance.

**Experiment (M1):** the conformance tests literally ask each worker to
commit and push and to write outside the tree, and assert that nothing
happened. Run them on every new vendor version.

## R8 — The design over-reaches after all

**Shape:** the daemon, the queue, the quota model, or a UI gets built before
the corpus shows they are needed, and maintenance grows past the value.

**Mitigation:** the milestone gates; the explicit list of cuts in
[00-verdict.md](00-verdict.md); the rule that the engine is a plain object
hosted by a process, so the daemon is an addition, not a rewrite.

**Experiment:** none; this is discipline. The tell is any PR that adds a
config key no task has needed yet.

# 00 — Verdict on the thesis

## The short version

**Build it, but build about a third of what the brief describes, and build the
parts in a different order than the brief implies.** The thesis holds at the
contract level and fails at the level it was stated.

The thesis as written:

> A local orchestrator that drives multiple vendor coding-agent CLIs as
> interchangeable workers, assigns them roles, and runs a task end-to-end
> through a verification-gated loop — where the model choice per role is
> configuration, not architecture.

What is true: a verification-gated loop, driven from the outside, with the
model per role as a config line, is worth mechanizing. You already run it by
hand every day. That is the strongest possible evidence of value, and it is
the only evidence that matters for a single-operator tool.

What is false: **the CLIs are not interchangeable workers.** They are
interchangeable *only* if the contract between the conductor and a worker is
narrowed to something both can satisfy today and any future CLI can satisfy
with near certainty. That contract is:

> Given a working directory, a prompt, and a sandbox policy, run to completion
> without prompting a human, leave the working tree modified, and write a
> file. Return an exit code and whatever text you produced.

Everything richer than that — structured output flags, streaming event
schemas, session resume, model and effort selection, tool allowlists — is
**optional, versioned, and must be treated as unreliable.** The core depends on
the narrow contract. The optional surface improves first-attempt quality and
observability; it never gates correctness. Files are the interface. This is
[ADR-0006](adr/0006-files-are-the-interface.md) and it is the most important
decision in the design.

This is not a hedge. The probes run during this session (see
[13-environment-findings.md](13-environment-findings.md)) found that between
Codex 0.36.0 and 0.145.0 the `--json` event format was replaced wholesale, the
`-a` approval flag was removed from `exec`, `proto` was renamed to
`app-server`, a config enum grew a value that hard-errors the older binary,
and the desktop app writes a shared config file that the older CLI cannot
parse. The installed npm CLI is currently unusable with your account for any
model. The vendor surface churned on every axis the brief warned about, in
one version gap, on your machine, today.

## Your hypothesis, attacked

You proposed that the plumbing is easy and the value is in (a) the task and
context spec, (b) the structured verdict, and (c) the termination policy.

**(a) Context spec: agree it is necessary, disagree that it is where the value
sits.** The context pack is mostly *your existing skills, inlined verbatim*.
Its design contribution is small: render once, hash it, give the same base to
every worker in the same role so the corpus can compare models on equal
information. The pack is a solved problem the moment you decide files are the
interface. It earns its place; it does not carry the project.

**(b) Verdict format: agree, and I would go further.** This is where the
system lives. But the format alone is not enough. The decisive rule is that
**a finding is only a finding if the conductor can confirm it by running
something.** The reviewer's most valuable output is not a list of findings; it
is a *failing test* it wrote against the implementer's tree. So the reviewer
must be allowed to write, in its own throwaway worktree, and the conductor
harvests only the reproduction files the verdict names. Everything else the
reviewer touched is discarded. That resolves "how does the reviewer see the
diff without helpfully fixing it" without needing a read-only sandbox: it can
fix all it likes, and none of it goes anywhere. See
[ADR-0007](adr/0007-executable-findings.md).

**(c) Termination policy: agree it matters, disagree that it is hard.** If
only confirmed findings enter the loop, oscillation mostly disappears by
construction, because the loop no longer iterates on opinions. It iterates on
a set of executable checks that only grows. Each round either shrinks the set
of failing checks or the run escalates to you. Round caps and budgets are
backstops, not the mechanism. Termination falls out of (b).

**What you left off the list, and what I rank above (a):** isolation and
harvest. The rule that exactly one worker writes the product tree per round,
serially, and that nothing leaves a reviewer's tree except named reproduction
files, is what makes the loop composable. Without it, "merge the implementer's
patch with the tester's fixes" becomes a three-way merge problem you never
have to solve if you never create it.

**And the plumbing is not easy.** It is not where the *value* is; it is where
the *cost* is. The maintenance tax is the project's central environmental
fact, and the design's job is to minimize the surface area exposed to it:
few flags, files not protocols, capabilities probed not assumed, every optional
flag droppable on retry.

## Where the value sits, ranked

1. **Executable-findings rule plus the verdict schema.** Turns review from
   opinion into fact. Kills oscillation. Makes the corpus honest.
2. **Isolation and harvest model.** Worktree per worker, one writer per round,
   harvest by name. Makes everything else composable.
3. **The run corpus.** The only thing in the system that compounds. Every run
   is a labeled sample of which model did what on your code.
4. **The context pack.** Necessary, mostly your existing material, cheap once
   files are the interface.
5. **Adapters and scheduling.** Pure cost. Keep them small.

## The simpler system that gets 80%

I looked for it. The candidate is: orchestrate from *inside* Claude Code, as a
skill that implements, then shells out to `codex exec` for review, then runs
tests. It is a day of work. It gets maybe 40%: no isolation, no persistence
beyond transcripts, no schema-validated verdicts, loop control living in a
prompt, and the orchestrator itself is one of the two vendors, which
reintroduces the shared-blind-spot problem at the control layer. I recommend
it as the **week-one experiment** for the one question that decides whether
the loop is worth building at all (does cross-vendor review produce
*confirmed* findings on your diffs?), and not as the product.

The 80% system is the walking skeleton in
[10-milestones.md](10-milestones.md): one foreground process, worktrees, the
verdict schema, one round, SQLite trace. No daemon, no queue, no quota model,
no UI. Most of what the brief calls "the scheduler" is deferred and some of it
is cut.

## What I cut from the brief, and why

- **A windowed-quota model for the scheduler (§6E) in v1.** Replaced by:
  per-provider concurrency semaphores, observed rate-limit signals where the
  CLI emits them (Claude Code does, with utilization and reset time per
  window), error classification, backoff, and a degradation ladder. A model of
  remaining budget is learned from the corpus later, not designed now.
- **A "tester" model role.** Verification is not a role. The conductor runs
  the commands. A model that fixes failing tests is just the implementer in
  the next round.
- **Third-model tie-breaking.** For v1, disagreements between reviewers do not
  need resolving because only confirmed findings act. Unconfirmable blockers
  in a small set of categories go to you, not to a third model.
- **MCP and raw-protocol integration surfaces.** Both are marked experimental,
  one was already renamed between the two Codex versions on this machine.
  Spawn the CLI and parse stdout. [ADR-0001](adr/0001-integration-surface.md).
- **Desktop app, TUI.** A read-only local web page over the SQLite database,
  added in milestone 5, answers the one thing a CLI cannot: findings anchored
  to diff lines. [ADR-0005](adr/0005-core-cli-split-no-daemon.md).
- **Multi-repo tasks in v1.** The task spec has a single `repo`. The upgrade
  path is a list, and nothing in the design blocks it.
- **Any generality beyond two adapters and your two workflows.** A third
  adapter is the conformance suite's proof, not a v1 feature.

## Things I most want to argue about

1. **Reviewers must be allowed to write.** You asked how to stop the reviewer
   from fixing things. I am proposing to let it, in a tree that is thrown
   away, because a reviewer that cannot write a failing test can only produce
   advice. If you insist on read-only reviewers, the executable-findings rule
   collapses to `command` and `acceptance` reproductions only, and I predict
   most findings become advice.
2. **The loop skips review while verification is red.** Reviewers only see
   verified-green diffs. This costs a fix sub-round sometimes but it means
   reviewer quota is never spent on code that was going to change anyway.
3. **Cross-vendor review is a policy, not an axiom.** The corpus should be
   able to test it. The config supports `require_cross_vendor_review:
   enforce | warn | off`; default `warn`.
4. **Codex on this machine is currently broken for orchestration** and the
   fix is yours to make (update the npm package, or point the config at the
   binary bundled in the desktop app). Both work; see the open questions.

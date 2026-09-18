# ADR-0007 — A review finding acts only if the conductor can confirm it

**Status:** proposed · **Date:** 2026-09-07

## Context

Reviewers produce chatty, low-value findings; implement → review → fix loops
oscillate; two models disagree with no arbiter. The operator's prior: a
finding is worth acting on only if it can be expressed as a failing test or
a concrete reproduction.

## Decision

Every `Finding` carries a `Reproduction` of kind `test`, `command`,
`acceptance`, or `none`. After review, the conductor runs each reproduction
against the implementer's worktree and records a `Confirmation`. Only
`confirmed` findings become fix targets for the next round. `refuted` and
`unappliable` findings become advice. `none` on a blocker or major becomes
advice, except in the `security` and `data-loss` categories where it
becomes `needs_human` and gates the run.

To make `test` reproductions possible, reviewers run with write access in a
throwaway worktree, and the conductor harvests only the files the verdict
names, restricted to `repro_allowed_paths`, and only if they do not touch
files the implementer changed. Confirmed reproductions join the
verification plan for the rest of the run; the set of checks only grows.

Termination follows: the loop ends when verification is green and no
confirmed findings are open, and escalates when a round fails to reduce
`debt = failing required steps + confirmed open findings`.

## Consequences

- Reviewer output is measurable: precision is confirmed over confirmed plus
  refuted. Models that produce advice are visibly cheaper to skip.
- The reviewer prompt must demand reproductions; a reviewer that cannot
  write tests contributes only `command` and `acceptance` kinds.
- Some genuine defects are unconfirmable and, outside the carved-out
  categories, will be reported as advice rather than fixed automatically.
  The operator can promote any advice to a fix target at a gate.
- The verdict schema is coupled to this rule; changing the rule changes the
  schema, which is why this is an ADR.

## Reopen when

M0 shows reviewers rarely produce confirmable findings on the operator's
code. Then review becomes an optional report pass and the loop is implement
→ verify only.

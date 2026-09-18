# agent-conductor — design documents

This directory is the output of the initial design session (2026-09-07). The
walking skeleton (milestone 1) has since been built; see
[15-implementation-status.md](15-implementation-status.md) for what exists,
what the first live runs showed, and where the code departs from these documents.

Read in this order:

| # | Document | What it answers |
|---|----------|-----------------|
| 00 | [Verdict on the thesis](00-verdict.md) | Should this be built, and where the value actually is |
| 01 | [Architecture](01-architecture.md) | Candidate shapes, the recommendation, diagrams |
| 02 | [Component map](02-component-map.md) | Modules, boundaries, dependency direction, core vs plugin |
| 03 | [Contracts](03-contracts.md) | Task spec, context pack, work product, verdict, verification result — as types |
| 04 | [Worker adapter contract](04-worker-adapter-contract.md) | What a vendor adapter implements, and what conformance asserts |
| 05 | [Loop control](05-loop-control.md) | Rounds, executable findings, termination, escalation |
| 06 | [Scheduler](06-scheduler.md) | Dispatch, quota, backoff, degradation, failure classification |
| 07 | [State and corpus](07-state-and-corpus.md) | SQLite schema, retention, the evaluation dataset |
| 08 | [Instruction portability](08-instruction-portability.md) | One source of truth for CLAUDE.md / AGENTS.md / skills |
| 09 | [Trust and blast radius](09-trust-and-blast-radius.md) | Sandboxes per vendor, git non-mutation, kill switch |
| 10 | [Milestones](10-milestones.md) | The walking skeleton, then each increment |
| 11 | [Risk register](11-risk-register.md) | What kills the project, and the experiment that exposes each |
| 12 | [Open questions](12-open-questions.md) | Decisions needed from the operator before implementation |
| 13 | [Environment findings](13-environment-findings.md) | Facts probed on this machine during the design session |
| 14 | [Config reference](14-config-reference.md) | Global and per-repo config files with worked examples |
| 15 | [Implementation status](15-implementation-status.md) | What is built, what the live runs showed, where the code departs from the design |

Architecture Decision Records live in [adr/](adr/README.md).

Terminology used throughout:

- **Operator** — the single human user of this tool. There is exactly one.
- **Task** — one unit of work handed to the conductor (a feature, a bug fix).
- **Run** — one attempt at a task. A task can have several runs.
- **Round** — one implement → verify → review cycle within a run.
- **Worker** — one invocation of a vendor CLI in a role.
- **Role** — `implementer`, `reviewer`, `reproducer`. Verification is not a role; the conductor does it itself.
- **Adapter** — the code that knows how to drive one vendor CLI.
- **Pack** — the context bundle rendered once per round and given to every worker.
- **Verdict** — a reviewer's structured output. Findings are executable or they are advice.
- **Harvest** — pulling reproduction files out of a reviewer's throwaway worktree.

# ADR-0003 — State store: SQLite plus a blob directory

**Status:** proposed · **Date:** 2026-09-07

## Context

Every run must be persisted with its full trace, and the accumulated runs
are an evaluation dataset queried ad hoc. Local-first, single operator,
multiple concurrent processes (two `conductor run` invocations sharing
provider leases).

## Decision

One SQLite database at `~/.conductor/conductor.db` in WAL mode, via
`node:sqlite`. Large artifacts (event streams, stdout/stderr, prompts,
packs, patches, harvested files) live under `~/.conductor/runs/<run_id>/`
and are referenced by path and, where integrity matters, by sha256. Schema
migrations are numbered SQL files applied at startup. Provider leases and
run heartbeats are rows, which is what makes multi-process coordination
work without a daemon.

Rejected: JSONL-only (fine for traces, painful for the corpus queries and
impossible for leases); Postgres or any server (violates local-first, adds
an install step for a personal tool); a document store or embedded KV
(no ad hoc SQL for the corpus, which is the whole point of the corpus).

## Consequences

- `sqlite3 ~/.conductor/conductor.db` is a complete debugging and analysis
  interface on day one.
- Export to JSONL is a query, not a feature.
- Retention is explicit: rows forever, blobs pruned on request.
- A future daemon or web view reads the same file; nothing migrates.

## Reopen when

Never expected. If multiple machines must share a corpus, sync the export,
not the database.

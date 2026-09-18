# ADR-0005 — Core/UI split: library plus foreground CLI, no daemon in v1

**Status:** proposed · **Date:** 2026-09-07

## Context

Stated intent: CLI first, desktop later. Runs last minutes to an hour. One
operator. Concurrency across runs is rare. State is in SQLite.

## Decision

`core` is a library exposing an `Engine` whose `run(task)` drives the loop
and writes to the store. `cli` hosts it in a foreground process per
invocation. Cross-process coordination (leases, heartbeats, kill) goes
through the database. There is no daemon, no socket, no TUI.

A read-only local web view (`conductor serve`) is planned for milestone 5
because a CLI cannot anchor findings to diff lines. It reads the database
and the run directory; it does not host the engine and it cannot approve
gates.

A daemon is the correct host when there is a real queue across sessions or
an interactive UI. Because the engine is a plain object, the daemon is a
new host, not a rewrite.

Rejected for v1: daemon (second failure domain, lifecycle, IPC, upgrades);
TUI (high effort, the terminal log plus `show` covers it); desktop app
(nothing a local web page cannot do for one operator).

## Consequences

- `conductor run` must be resumable from the database so a closed terminal
  is not a lost run.
- Two tasks at once means two terminals; leases keep them within provider
  limits.
- Gates block on stdin by default; `--no-wait` exits with status `gated`
  for scripted use.

## Reopen when

The operator has three tasks waiting at once regularly, or gate approval
from the web view becomes the dominant interaction.

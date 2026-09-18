# ADR-0004 — Language and runtime: TypeScript on Node LTS

**Status:** proposed · **Date:** 2026-09-07

## Context

The operator is fluent in TypeScript and Python. The tool's work is:
spawning and supervising child processes, parsing JSONL streams, validating
schemas, driving git, writing SQLite, and printing to a terminal. It is
distributed to contributors who write adapters against a typed contract.
Both vendor CLIs are npm packages. Node 26 is installed.

## Decision

TypeScript, Node ≥ 22 (for built-in `node:sqlite`), pnpm workspace, zod for
contracts with JSON Schema generation so the same definition validates
worker output files and feeds native structured-output flags. Distribution
via npm, the same channel as the CLIs it drives. No bundling into a single
binary.

Against Python (the real alternative): equally capable for process
supervision with asyncio and for SQLite; loses on the contract story
(pydantic is comparable, but the adapter contract as a TypeScript interface
is the document adapter authors read, and the CLIs' own ecosystems are
npm); ties on distribution (pipx vs npm). The tie-breaker is that the
contracts are the product and TypeScript keeps them as one artifact.

Against Go or Rust: a single static binary is attractive and unnecessary
(the operator already has Node for the CLIs); the adapter contributor pool
for npm-shipped agent tools is overwhelmingly TypeScript; the operator's
fluency is a hard input to a single-maintainer project.

Against Bun or Deno: less boring; `node:sqlite` and process-group semantics
are the things most likely to differ; nothing needed is faster in them.

## Consequences

- Process supervision uses `child_process.spawn` with `detached: true`,
  explicit `AbortSignal` timers, and process-group kills. No shell
  `timeout` (absent on macOS).
- One native-free dependency set; `npm i -g @agent-conductor/cli` is the
  install.
- Contributors need Node only.

## Reopen when

A hard requirement for a single binary appears (e.g. running on machines
without Node), which this project's constraints make unlikely.

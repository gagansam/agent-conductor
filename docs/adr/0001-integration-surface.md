# ADR-0001 — Integration surface per vendor: spawn the CLI, parse stdout

**Status:** proposed · **Date:** 2026-09-07

## Context

Three surfaces exist per vendor: (1) spawn the CLI and parse its structured
event stream, (2) speak MCP to it, (3) speak its raw protocol.

Observed on this machine ([13-environment-findings.md](../13-environment-findings.md)):

- Codex 0.36.0: `exec --json`, `mcp` (experimental), `proto`.
- Codex 0.145.0: `exec --json` with a **different** event format, `mcp-server`,
  `app-server` (experimental; `proto` is gone), `exec-server` (experimental).
- Claude Code 2.1.258: `-p --output-format stream-json`, `--json-schema`,
  `--resume`. Its MCP server mode exposes Claude Code's *tools* to an MCP
  client, not its agent loop, so it is not a worker surface. The Agent SDK
  wraps the same CLI.

Both experimental surfaces changed names between the two Codex versions.
The raw protocol is the vendor's internal contract with its own UI and
carries no stability promise.

## Decision

Both adapters spawn the CLI as a child process in its own process group and
parse stdout. Claude: `claude -p … --output-format stream-json --verbose`.
Codex: `codex exec --json …` with stdin closed. The event parsers are
version-selected and fixture-tested. The core depends only on: process
started, process ended, exit code, classification, the output file, the
working tree.

Rejected: MCP (adds a client implementation, a second protocol to track,
unclear cwd/sandbox semantics, marked experimental on the Codex side);
raw protocol / app-server (undocumented stability, already renamed once);
Claude Agent SDK (a layer over the same CLI; subscription-auth behaviour
unverified; nothing it offers is needed by the narrow contract).

## Consequences

- Adapters are small and disposable. When a vendor changes its stream, the
  fix is a new parser and new fixtures, not a core change.
- Fine-grained control (interrupting a turn mid-tool-call, answering
  approval prompts) is unavailable. The design does not need it: approvals
  are disabled by policy and interruption is process-group kill.
- Streaming is best-effort. An adapter may legitimately yield no events
  until exit; the core uses a file-activity heartbeat as the idle signal
  then.

## Reopen when

A vendor deprecates its non-interactive CLI mode, or documents and stabilizes
an MCP or app-server surface with explicit compatibility guarantees and the
CLI surface loses a capability the loop needs (e.g. structured output).

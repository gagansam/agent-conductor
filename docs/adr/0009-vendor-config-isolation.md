# ADR-0009 — Each adapter runs its CLI against a conductor-owned config home

**Status:** proposed · **Date:** 2026-09-07

## Context

Observed on this machine: `~/.codex/config.toml` is written by Codex Desktop
(0.147) and cannot be parsed by the npm CLI (0.36); it names a model the
older CLI cannot use; it declares MCP servers that fail to start under
`exec`, costing ten seconds and error events per run. `~/.claude/CLAUDE.md`
grants blanket bash permission and, with three claude.ai MCP servers in
needs-auth state, loads into every headless run. A per-invocation override
fixed the parse error but not the model or the MCP noise.

## Decision

Adapters never run the CLI against the operator's config. Each adapter owns
a directory under `~/.conductor/vendor/` and borrows only authentication:

- Codex: `CODEX_HOME=~/.conductor/vendor/codex-home` containing a symlink to
  `~/.codex/auth.json` and a minimal conductor-written `config.toml`
  (verified to work on 0.36.0 and 0.145.0). Model id always passed with `-m`.
  `--ignore-user-config` and `--ignore-rules` added where the version has them.
- Claude Code: `--setting-sources project` (no user-level settings, no global
  `CLAUDE.md`), `--settings ~/.conductor/vendor/claude-settings.json` for
  conductor-owned permissions, `--strict-mcp-config` with no MCP servers.
  Authentication is the CLI's own login and is untouched.

`conductor doctor` reports the operator's config problems (such as the
`xhigh` enum) as information, never tries to fix them, and confirms the
isolated home works.

## Consequences

- Runs are reproducible: the only inputs are the pack, the policy, and the
  model id, not whatever the desktop app last wrote.
- Faster and quieter runs (no foreign MCP servers).
- Vendor features the operator enabled interactively (plugins, personality,
  notifications) do not apply to workers. That is intended.
- If a vendor moves auth out of its home directory (e.g. keychain only),
  the adapter's `detect` must find the new mechanism; this is a conformance
  fixture, not a core change.

## Reopen when

A vendor removes the ability to point the CLI at an alternate home and
offers no equivalent flag set.

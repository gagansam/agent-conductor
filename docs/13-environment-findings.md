# 13 — Environment findings (probed 2026-09-07)

Facts observed on the operator's machine during the design session, beyond
those already listed in the brief. Each fact changed a design decision; the
decision it changed is named. Probes cost a handful of trivial prompts.

## Toolchain

| Item | Observed |
|------|----------|
| Node | v26.7.0 |
| pnpm | 11.1.2 |
| Python | 3.13.1 |
| `claude` (npm) | 2.1.258 |
| `codex` (npm, `~/.npm-global/bin/codex`) | 0.36.0 |
| `codex` bundled in `/Applications/Codex.app/Contents/Resources/codex` | 0.145.0-alpha.27 |
| Latest `@openai/codex` on npm | 0.153.4 |
| macOS `timeout(1)` | absent (use the spawner's own timers, never shell `timeout`) |

## Codex: the installed npm CLI is unusable with this account

1. `codex exec` (0.36.0) fails to load `~/.codex/config.toml` because of
   `model_reasoning_effort = "xhigh"`. A per-invocation override
   `-c model_reasoning_effort=high` **does** get past the load error.
2. With the override, the model inherited from the shared config
   (`gpt-5.6-sol`) is rejected by the API: "requires a newer version of Codex".
3. With `-m gpt-5-codex` or `-m gpt-5`, the API rejects both: "not supported
   when using Codex with a ChatGPT account". No model tried works on 0.36.0
   with this login.
4. The user's `~/.codex/config.toml` declares MCP servers (`computer-use`,
   `cua_repl`) that fail to start under `exec`, adding roughly ten seconds
   of startup and two error events per run.
5. **`codex exec` exits 0 after an unrecoverable API error.** The failure is
   visible only as `{"type":"error"}` (0.36) events on stdout. Exit codes are
   not a reliable success signal. → Failure classification parses the event
   stream ([06-scheduler.md](06-scheduler.md)); adapters must never trust
   exit code alone.
6. `~/.codex` is shared with Codex Desktop (session rollouts record
   `originator: "Codex Desktop"`, `cli_version: "0.147.0-alpha.6.5"`). Two
   vendor products of different versions write one config file. →
   [ADR-0009](adr/0009-vendor-config-isolation.md).

## Codex: an isolated home works

`CODEX_HOME=<dir>` with `auth.json` symlinked from `~/.codex/auth.json` and a
minimal `config.toml` is honored by both 0.36.0 and 0.145.0. Session rollouts
land under `<dir>/sessions/`. The bundled 0.145.0 binary, run this way with no
`-m`, completed a trivial prompt successfully with the subscription login:

```
{"type":"thread.started","thread_id":"01a07802-..."}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":14487,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
```

Also observed: stderr prints `Reading additional input from stdin...` unless
stdin is closed. Adapters must close stdin or pass the prompt on stdin
deliberately, never leave it open.

## Codex: surface churn between 0.36.0 and 0.145.0

| Axis | 0.36.0 | 0.145.0 |
|------|--------|---------|
| `--json` event shape | `{"id":"0","msg":{"type":"task_started",...}}` | `{"type":"thread.started"}`, `item.completed`, `turn.completed` |
| Approval flag on `exec` | not accepted (`-a` errors: "unexpected argument"); defaults to `never` | not present; `-c approval_policy=...` |
| Structured output | none | `--output-schema <FILE>` |
| Config isolation | `CODEX_HOME` only | `CODEX_HOME`, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--strict-config` |
| Extra writable dirs | none | `--add-dir` |
| Raw protocol | `codex proto` | removed; `codex app-server` (experimental) |
| MCP server mode | `codex mcp` (experimental) | `codex mcp-server` |
| Non-interactive review | none | `codex review` (`--uncommitted`, custom prompt) |
| Diagnostics | none | `codex doctor`, `codex features` |

Every row is a thing an adapter would have hardcoded. → capability probing
per version ([04-worker-adapter-contract.md](04-worker-adapter-contract.md)).

## Claude Code: quota is observable

`claude -p ... --output-format stream-json --verbose` emits
`rate_limit_event` records:

```
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1788724200,
 "rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false,
 "unifiedWindows":{"five_hour":{"utilization":0.23,"resetsAt":1788724200},
                   "seven_day":{"utilization":0.2,"resetsAt":1789099200}}}, ...}
```

Utilization per window and reset epoch are available on every run. → The
scheduler's dispatch gate for Claude is data-driven, not estimated
([06-scheduler.md](06-scheduler.md)). No equivalent was observed in Codex
`exec --json`; that is an open probe.

Other Claude Code observations:

- `system/init` event carries `session_id`, `model`, `permissionMode`, the
  tool list and MCP server statuses. Three claude.ai MCP servers are in
  `needs-auth` state on this machine and get loaded into every headless run
  unless `--strict-mcp-config` is passed.
- `result` event carries `total_cost_usd`, `usage`, `modelUsage` per model
  (a Haiku helper model appears alongside the main model), `duration_api_ms`.
- Permission modes: `acceptEdits`, `auto`, `bypassPermissions`, `manual`,
  `dontAsk`, `plan`.
- `--restricted` removes code-running tools, ignores user/project/local
  settings, confines file tools to the working directories, and refuses
  `bypassPermissions`. `--setting-sources user,project,local` selects which
  settings load. `--settings <file>` adds a conductor-owned settings file.
- `--max-turns`, `--max-budget-usd` exist as hard caps.
- The global `~/.claude/CLAUDE.md` on this machine grants blanket bash
  permission. It is loaded into every headless run unless settings sources
  are restricted. The conductor should not inherit it.

## Addendum, 2026-09-18 (first implementation session)

Observed while building and running the adapters. Each is covered by a
recorded fixture or a test.

| Finding | Consequence |
|---|---|
| Codex 0.145 exits **1** on a failed turn (`turn.failed`); 0.36 exited 0 | classification reads the event stream on both; 0.36 is a recorded fixture, 0.145 a unit test |
| Codex prints a usage limit as an `error` event: "You've hit your usage limit … try again at <date and time>." | parsed into a `rate_limit` event with `resets_at`; stored as `cooling_until`. This is the only quota signal Codex gives |
| Codex appends `[projects."<cwd>"] trust_level = "trusted"` to the `config.toml` in its home for every directory it runs in | a second reason for the isolated `CODEX_HOME` (ADR-0009): worker runs would otherwise write throwaway worktree paths into the operator's config |
| `codex exec resume` accepts no `-s` on any version. On 0.36 it accepts only `-c` and `--last`: `exec resume <id> --json` is a usage error, while `exec --json … resume <id> -` parses on 0.36 and 0.145 and, on 0.145, continues the same `thread_id` with JSON output. `-c sandbox_mode="read-only"` is reflected in 0.36's run header | the adapter puts every flag before `resume` and always uses the `-c` form for the sandbox. Whether `sandbox_mode` is *enforced* on 0.145 is not yet verified: that needs a live run that writes |
| The symlinked `auth.json` was still a symlink after live runs | token refresh (if any happened) wrote through it. `detect()` refuses to continue if it ever finds a regular file there |
| Claude Code 2.1.263: `--max-turns` is gone from `--help` (present on 2.1.258). New: `--permission-prompts none`, `--bare`, `--safe-mode`, `--no-session-persistence` | the adapter uses `--permission-prompts none` when present; never depended on `--max-turns` |
| Claude Code with `--setting-sources project --strict-mcp-config`: `init` event shows `mcp_servers: []`, `plugins: []` | isolation verified; authentication unaffected |
| Claude Code `-p --resume <id>` with the prompt on stdin continues the session in the same worktree | fix attempts and repair turns reuse the implementer's context |
| Claude Code under `acceptEdits` auto-allows `mkdir` / `rm` inside the cwd without an allow rule | an implementer can delete files; deletions are now always surfaced |
| In a real run, cache reads were over 95% of input tokens | `cached_input_tokens` is reported separately |
| `node --test <dir>/` fails on Node 26 (a directory is not a test file) | not a conductor bug, but the cause of finding 2 in [15-implementation-status.md](15-implementation-status.md) |
| `git apply --3way` implies `--index` | `conductor apply --3way` uses a throwaway index so nothing is staged |
| `git commit --no-verify` skips `pre-commit` and `commit-msg` but not `reference-transaction` | that hook is the one that holds |

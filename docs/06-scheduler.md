# 06 — Scheduler (dispatcher)

## What the brief asked for and what I am proposing instead

The brief asks for a scheduler that models remaining budget per provider
across windowed quotas and plans around it. I am proposing something
smaller for v1, because:

1. Only Claude Code exposes quota state (five-hour and seven-day utilization
   with reset times, on every run). Codex `exec --json` showed no such signal
   in the probes. A model built on one observed and one imagined input is a
   guess wearing a graph.
2. You are one operator. Your default concurrency is one worker per provider.
   Most of the time the "schedule" is a queue of length one.
3. The corpus will contain every rate-limit event with timestamps. A budget
   model should be fitted to that later, not designed now.

So v1 is: **leases, observed signals, classification, backoff, a degradation
ladder, and pause-not-fail.**

## Units of work

A **step** is one worker invocation: `(run, round, role, provider, model)`.
Steps within a round have a fixed order ([05-loop-control.md](05-loop-control.md));
the only parallelism in v1 is multiple reviewers in the same round, and
multiple *runs* in separate processes.

## Leases

`provider_leases` table in SQLite: `(provider, holder_pid, worker_run_id,
acquired_at, heartbeat_at)`. A step may start when
`count(leases where provider = p and heartbeat fresh) < providers[p].max_concurrent`.
Leases are in the database, not in memory, so two `conductor run` processes
share the limit. Stale leases (heartbeat older than 60 s) are reaped by
whoever looks next.

Default `max_concurrent: 1` per provider. Raising it is a quota decision the
operator makes in config, as the brief requires.

## Dispatch gate

Before spawning a step for provider `p`, in order:

1. `~/.conductor/STOP` exists → do not dispatch; run status `paused`.
2. `provider_state[p].cooling_until > now` → do not dispatch; try degradation.
3. `provider_state[p].utilization_5h >= providers[p].reserve_utilization`
   (default 0.85, Claude only until Codex exposes a signal) → cooling until
   `resets_at`; try degradation.
4. Lease available → spawn.

`provider_state` is updated from every `rate_limit` event and every
`rate_limited` classification.

## Classification → policy

| Classification | Immediate action | Retry? | Provider effect |
|---|---|---|---|
| `ok` | continue | — | record usage |
| `rate_limited` | requeue step | yes, after cooling | cooling = `retry_after` if given, else exponential 2m → 4m → … → 30m; reset on success |
| `auth_failed` | pause run, notify | no | provider `unavailable` until `doctor` passes |
| `model_rejected` | retry once with the role's `fallback` model/provider | once | mark model label `rejected` in `capabilities_cache`; `doctor` reports it |
| `config_rejected` | retry once with all optional flags dropped | once | note in `capabilities_cache` |
| `cli_usage_error` | same as `config_rejected` | once | same |
| `timeout_idle` | kill group; retry once with resume if available | once | — |
| `timeout_total` | kill group; fail step | no | — |
| `killed` | fail step; run `paused` | no | — |
| `crashed` | retry once, fresh | once | consecutive_failures++ ; ≥ 3 ⇒ cooling 10 min |
| `vendor_error` | retry once | once | same as crashed |
| `invalid_output` (core) | repair turn | once | — |
| `empty_diff` (core) | see loop control | — | — |
| `git_mutated` (core) | fail step; escalate; keep worktree for inspection | no | — |
| `sandbox_violation` (core) | fail step; escalate; provider flagged in `doctor` | no | — |

Every retry counts against `max_worker_runs`.

## Degradation ladder

When a step cannot be dispatched to its provider, try in order:

1. **Drop optional roles.** A reviewer with `optional: true` is skipped this
   round; the round record says so.
2. **Wait, if short.** If `cooling_until` is within `loop.max_quota_wait_ms`
   (default 15 min) and the run has wall-clock budget, wait.
3. **Reroute.** If the role has `fallback` entries whose provider is
   dispatchable, use the first. For a reviewer this may violate
   `require_cross_vendor_review`; under `enforce` this step is skipped,
   under `warn` it proceeds and the verdict is tagged `same_vendor: true` for
   the corpus.
4. **Pause.** Run status `waiting_quota` with `resume_at = min(cooling_until)`.
   The process either waits (default) or exits with status `paused` under
   `--no-wait`, and `conductor resume <run>` continues later. Notify.

Never: skip verification, silently reduce `max_rounds`, or fail the task
because of quota.

## Hangs, crashes, empties, and bad patches

- **Hang**: no `WorkerEvent` for `idle_ms` (default 10 min) → SIGTERM the
  process group, 10 s later SIGKILL. Adapters without streaming events get a
  file-activity heartbeat instead: the core watches `cwd` and `log_dir` for
  mtime changes.
- **Nonzero exit**: classified by the adapter; policy above.
- **Empty diff**: computed by the core after the worker exits. If the report
  says every criterion is `done` or `not_applicable`, the round proceeds to
  verification (the implementer may legitimately have found nothing to
  change). Otherwise one retry with a prompt addendum stating that no files
  changed; then `escalate: empty_diff`.
- **Patch does not apply**: cannot happen to the implementer's own patch (it
  is the worktree). Can happen to harvested reproductions → `unappliable`.
  Can happen at `conductor apply` if the primary checkout moved → `apply`
  refuses and prints the three-way conflict instructions.
- **Process died with the run half-done**: `runs.state.json` has the pid and
  a heartbeat. `conductor` on any invocation reaps runs whose pid is dead:
  status `crashed`, worktrees kept, leases released. `conductor resume`
  restarts from the last completed step.

## Multiple tasks

v1 supports N tasks as N processes sharing the database. Ordering between
them is whatever the operator started first; leases give per-provider
fairness by accident, not design. A real queue with priorities is the daemon
shape ([ADR-0005](adr/0005-core-cli-split-no-daemon.md)) and is deferred
until you actually have three tasks waiting at once.

## What the corpus should make learnable later

Per provider: usage per worker run by role and task kind; rate-limit events
with utilization and reset time; time-of-day patterns. From this a v2 can
estimate "how many implementer runs are left in this window" and plan
reviewer count accordingly. Designing that estimator now, without the data,
is the thing the brief warned against.

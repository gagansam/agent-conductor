# 12 — Open questions for the operator

> **Status, 2026-09-18.** Implementation proceeded on the recommendations below.
> Resolved by the code: **Q1** (`conductor init` picks the newest Codex binary it
> finds; the app-bundled 0.145 works and the npm 0.36 does not need updating),
> **Q5** (`~/.conductor`, override with `CONDUCTOR_HOME`), **Q6** (default gates
> are `after_review` and `before_apply`), **Q7** (Node ≥ 22.13, `node:sqlite`),
> **Q8** (refuse only on overlapping files), **Q13** (no Agent SDK). Built as
> recommended and still yours to veto: **Q4** (reviewers write in a throwaway
> tree). Still open and blocking real use: **Q3** and **Q9** (per-repo config),
> **Q2** (plan tiers). New: the packages declare no license; pick one before
> the repo is advertised.

Decisions I need from you before implementation starts. Each has my
recommendation; a one-word answer is enough where you agree.

## Q1 — Which Codex binary? (blocking for M0)

The npm `codex` 0.36.0 cannot use any model with your ChatGPT login. The
binary bundled in Codex.app (0.145.0-alpha.27) works with an isolated home,
and npm has 0.153.4. Options: update the npm package, or set
`providers.codex.binary` to the app bundle path.

**Recommendation:** update the npm package (`npm i -g @openai/codex@latest`)
so `doctor` has a stable path, and keep the bundle path as a documented
fallback. I did not run the update; it changes your machine.

## Q2 — Plan tiers (affects defaults)

Which Claude plan (Pro, Max 5x, Max 20x) and which ChatGPT plan (Plus, Pro)?
This sets `max_concurrent`, `reserve_utilization`, default `max_rounds`, and
whether a second reviewer is ever on by default.

**Recommendation:** ship defaults for the most constrained plausible tier
(one worker per provider, one reviewer, three rounds) and let the M1 usage
data argue for more.

## Q3 — Verification commands per repo (blocking for M1)

For the Next.js frontend and the Starlette backend: the exact commands for
typecheck, lint, unit, and (if any) e2e; whether they run non-interactively
in a fresh worktree; what `.env` files they need; whether e2e needs the
backend running. Your `verify-change` skill presumably lists them; I need
them as `.conductor/config.yaml` entries with timeouts.

**Recommendation:** junit output for every test runner from day one
(`vitest --reporter=junit`, `pytest --junitxml`) so failures reach the
implementer as structured targets, not log tails.

## Q4 — Reviewers may write (design-level)

The executable-findings rule depends on reviewers writing reproduction tests
in their own throwaway worktree. Do you accept that, or do you want
reviewers read-only?

**Recommendation:** accept. Read-only reviewers reduce the loop to command
and acceptance reproductions and I expect most findings to become advice.

## Q5 — Where state lives

`~/.conductor/` for the database, runs, and worktrees (recommended), versus
inside each repo. Worktrees inside the repo directory confuse tooling that
globs the tree; outside is cleaner. Repo-level config stays in
`<repo>/.conductor/config.yaml`.

**Recommendation:** home directory.

## Q6 — Default gates

`before_apply` is always on because `apply` is a separate command. Should
`after_review` also default on for the first weeks, so you see every verdict
before a second round spends quota?

**Recommendation:** yes for M1 and M2; off by default from M3.

## Q7 — Runtime floor

Node 26 is installed. `node:sqlite` is built in from Node 22 and avoids a
native dependency. Is Node ≥ 22 an acceptable floor for the public repo?

**Recommendation:** yes; document it and use `node:sqlite`.

## Q8 — `apply` onto a dirty primary checkout

Refuse when the primary checkout has uncommitted changes to files the patch
touches, allow otherwise. Or refuse on any dirty state?

**Recommendation:** refuse only on overlapping files; you often have
unrelated edits in flight.

## Q9 — Instruction sources (blocking for M1)

Confirm the paths of the skills to inline (`verify-change`, `expert-review`,
the two workflow skills) and the invariant docs, per repo. And whether
making `AGENTS.md` canonical with `CLAUDE.md` as `@AGENTS.md` is acceptable
for the repos where `CLAUDE.md` currently carries content.

**Recommendation:** do the rename in each repo before M1 so the pack and
the interactive path read identical text.

## Q10 — Single repo per task in v1

The legacy Django reference app is "behavioral reference", not a target.
Can a task's `context_files` point at paths in another checkout (read-only
excerpts inlined into the pack) while the worktree is still single-repo?

**Recommendation:** yes, as `context_files` entries with absolute paths;
no second worktree.

## Q11 — What counts as a "browser run"

If verification must include a real browser, is it Playwright against a
local dev server, and does that server need the backend and a database?
This decides whether M5's `services` hooks are needed earlier.

**Recommendation:** keep browser steps `required: false` until services
hooks exist, so a flaky e2e cannot block a round.

## Q12 — Name

Repo is `agent-conductor`; CLI `conductor`; home `~/.conductor`; npm scope
`@agent-conductor/*`. Any objection?

## Q13 — Claude Agent SDK

I recommend not depending on it: it adds a layer over the same CLI, and its
authentication path for subscription (non-API-key) logins is something I
did not verify. If you know it works with your login, it is still not
needed. Confirm we skip it.

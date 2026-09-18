# agent-conductor — instructions for coding agents

This file is the single source of truth for agent instructions in this repository. `CLAUDE.md`
only imports it. Design lives in `docs/`; start with `docs/README.md`.

## What this is

A local orchestrator that drives vendor coding-agent CLIs (Claude Code, Codex) through an
implement → verify → review loop. TypeScript, Node ≥ 22, pnpm workspace, ESM.

## Layout and the one boundary rule

```
packages/adapter-api     the adapter contract, shared process helper, conformance harness
packages/adapter-*       one package per vendor CLI; disposable, rewritten when a vendor changes
packages/core            contracts, isolation, pack, verifier, confirmer, dispatcher, store, engine
packages/cli             the `conductor` binary; argument parsing and printing only
```

- **If a change to `packages/core` mentions a vendor name, a CLI flag, or a vendor event type, it is
  in the wrong package.** Vendor knowledge lives only in `packages/adapter-<vendor>`.
- Adapters import `@agent-conductor/adapter-api` and nothing else from this repo. `core` never
  imports an adapter; the CLI loads adapters by package name and hands instances to the engine.
- `cli` contains no logic worth testing. If it does, move it to `core`.

## Conventions

- Relative imports carry the `.js` extension. `verbatimModuleSyntax` is on: use `import type`.
- Contracts are zod schemas in `packages/core/src/contracts`. Anything a model writes is validated
  against them; anything the conductor can compute (diff stats, exit codes, hashes) is never taken
  from a model. Field names in `docs/03-contracts.md` and the schemas must agree.
- Every optional CLI flag an adapter adds goes through `ArgvBuilder.optional(capability, …)`, so the
  dispatcher can retry with all of them dropped. An adapter must work with zero optional flags.
- Never classify a worker run from its exit code alone. Read the event stream and stderr.
- The conductor's own code never commits, stages, pushes or moves a ref. The only write to an
  operator's checkout is `conductor apply`, which applies a patch and stages nothing.
- Comments explain why, not what. No comment is better than a comment restating the code.

## Checks

```
pnpm typecheck     # tsc over all packages and tests
pnpm test          # vitest: unit tests, engine tests on temp git repos, offline adapter conformance
pnpm build         # tsc -b; produces packages/*/dist
```

All three must pass. New behaviour needs a test. Engine behaviour is tested through
`@agent-conductor/adapter-fake` against a temporary git repository (`packages/core/test/helpers/repo.ts`);
never against a real vendor CLI.

Adapter changes need fixtures: real captures under `packages/adapter-<vendor>/fixtures/<cli-version>/`.
Record them with `conductor doctor --live <provider> --record packages/adapter-<vendor>/fixtures`
(uses quota; output is sanitized). Fixtures are public: they must not contain usernames or home paths.

## Do not

- Do not change git state in any way. Leave changes unstaged in the working tree.
- Do not add dependencies without saying why in your report. The runtime set is deliberately tiny:
  zod, yaml, picomatch, fast-xml-parser.
- Do not hardcode a model id anywhere outside a config file or a fixture.
- Do not add a config key that no task has needed yet.

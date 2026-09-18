# ADR-0006 — Files are the interface between the conductor and a worker

**Status:** proposed · **Date:** 2026-09-07

## Context

Vendor CLIs differ in how they accept context (argv, stdin, config files,
ambient instruction files) and how they return structured output
(`--json-schema`, `--output-schema`, nothing). Every one of those flags has
changed or appeared within the version ranges observed on this machine.

## Decision

The conductor gives a worker a directory and takes back a directory.

- Input: the rendered pack at `<worktree>/.conductor/pack/`, and the prompt
  text (which references those files). The prompt is the only thing passed
  through the CLI's own input path.
- Output: the worker writes its role's JSON file to `<worktree>/.conductor/out/`.
  The conductor validates it against the JSON Schema. On failure, one
  repair turn. The product itself (the code change) is read from the
  worktree by `git diff`, never from anything the model says.

Native structured-output flags are used when the adapter reports them, by
passing the same schema, purely to raise first-attempt validity. The core
never branches on whether they exist. The `.conductor/` directory is
excluded from diffs by pathspec and from `git status` by `info/exclude`.

## Consequences

- One code path for structured output across all vendors and versions,
  tested by the same conformance assertion.
- Adapters that lose a flag degrade to "prompt-only structured output"
  without a core change.
- A repair turn costs one worker run when a model ignores the instruction.
  The corpus records how often that happens per model.
- Workers can re-read their context with their own tools, which works
  identically across vendors.

## Reopen when

Every supported vendor offers a stable, schema-validated structured-output
contract *and* the repair-turn rate is a measurable quota cost. Even then,
the file remains the fallback.

# 08 — Instruction portability

## The problem

Claude Code reads `CLAUDE.md` and `.claude/skills/*/SKILL.md`. Codex reads
`AGENTS.md`. You have domain-invariant docs, a `verify-change` gate, an
`expert-review` pass, and two workflow skills, and you do not want two
copies of any of them.

## The recommendation

**Two mechanisms, no projection tool.**

### 1. For the orchestrated path: the conductor inlines, vendors are bypassed

When a worker runs under the conductor, it does not depend on the vendor's
instruction-loading mechanism at all. The pack builder reads the instruction
sources listed in the repo config, strips vendor frontmatter, and inlines
them into `INSTRUCTIONS.md` with a provenance header per document. Both
vendors get byte-identical instructions. There is nothing to drift because
there is one copy and the conductor is the only reader that matters.

```yaml
# .conductor/config.yaml
instructions:
  sources:
    - AGENTS.md
    - docs/invariants/**/*.md
    - .claude/skills/verify-change/SKILL.md
    - .claude/skills/expert-review/SKILL.md
    - .claude/skills/implement-feature/SKILL.md
    - .claude/skills/fix-bug/SKILL.md
```

Frontmatter can scope a document to roles:

```yaml
---
name: expert-review
description: ...
conductor:
  roles: [reviewer]        # default: all roles
---
```

Sources may also sit outside the repository, as `../` or absolute paths. A
workspace folder that holds several repositories and keeps one AGENTS.md and
one `.claude/skills/` for all of them (the operator's own layout) is the case
this serves: every repository's config points at the same files, which are
read from disk when a run starts. Files inside the repository are read from
the base commit instead, so the pack matches the code under work.

The skill files stay where they are and keep working interactively in Claude
Code. The conductor treats them as plain markdown with a known header.

The pack builder also runs a **lint**: Claude-specific tokens inside an
inlined document (`$ARGUMENTS`, tool names like `Bash(`, `@`-imports,
`allowed-tools:` in frontmatter) produce a warning in `conductor doctor`,
because they mean nothing to the other vendor. The fix is to move the
vendor-specific line out of the shared body, not to project it.

The vendor's own ambient loading is suppressed where possible so the pack is
the only instruction source: Claude Code with `--setting-sources` limited and
a conductor-owned `--settings` file; Codex with `CODEX_HOME` and
`--ignore-user-config` where the version supports it. `AGENTS.md` and
`CLAUDE.md` in the worktree will still be read by the CLIs because they are
checked in; that is fine because with the next mechanism they are the same
content.

### 2. For the interactive path: `AGENTS.md` is canonical, `CLAUDE.md` imports it

Claude Code supports `@path` imports inside `CLAUDE.md`. So:

```
# CLAUDE.md
@AGENTS.md
```

One line. `AGENTS.md` holds the repo-wide instructions. Codex reads it
natively; Claude reads it via the import. No generation step, no hash
header, no drift, because there is one file.

Anything that only makes sense to one vendor (Claude-specific tool
permissions, Codex-specific config) goes in that vendor's own file
(`.claude/settings.json`, `.codex/config.toml`), never in `AGENTS.md`.

Skills remain Claude-native for interactive use. Codex interactive sessions
do not get them. If that turns out to matter, the cheap answer is a section
in `AGENTS.md` that says "for a review, read `.claude/skills/expert-review/SKILL.md`",
which both vendors can follow. I would not build a projection tool for this
until you have hit the problem twice.

## Drift detection

`conductor doctor` checks, per repo:

1. `CLAUDE.md` consists of the import line plus at most a comment; anything
   else is flagged as "content that Codex will not see".
2. Every path in `instructions.sources` exists.
3. Lint warnings from inlining (vendor-specific tokens).
4. `AGENTS.md` does not itself contain `@`-imports (Codex does not expand
   them).
5. Optional: a `pre-commit` hook snippet that runs the same checks, for the
   operator to install by hand. The conductor never installs git hooks in
   the primary checkout.

## What is deliberately not solved

- Codex's `.rules` / execpolicy files and any Codex skill mechanism that may
  exist in newer versions. Not needed for the orchestrated path; not chased.
- Per-directory `CLAUDE.md` files deeper in the tree. If you use them, add
  them to `instructions.sources` with a role scope and they are inlined like
  everything else. The import trick applies to each of them too.
- Global `~/.claude/CLAUDE.md`. It is yours, it is loaded interactively, and
  the conductor suppresses it for workers via `--setting-sources`. It
  currently grants blanket bash permission, which the conductor must not
  inherit ([09-trust-and-blast-radius.md](09-trust-and-blast-radius.md)).

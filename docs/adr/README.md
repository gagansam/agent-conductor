# Architecture Decision Records

Decisions that are expensive to reverse. Format: context, decision,
consequences, alternatives rejected, and the trigger that would reopen it.

| ADR | Decision | Status |
|-----|----------|--------|
| [0001](0001-integration-surface.md) | Spawn the vendor CLI and parse its stdout; no MCP, no raw protocol | proposed |
| [0002](0002-isolation-worktrees.md) | Detached git worktree per worker, outside the repo; harvest by name | proposed |
| [0003](0003-state-store-sqlite.md) | SQLite plus a blob directory | proposed |
| [0004](0004-language-typescript-node.md) | TypeScript on Node LTS, pnpm workspace, zod contracts | proposed |
| [0005](0005-core-cli-split-no-daemon.md) | Library plus foreground CLI; no daemon, no TUI, read-only web view later | proposed |
| [0006](0006-files-are-the-interface.md) | Workers communicate through files in the worktree; flags are optimizations | proposed |
| [0007](0007-executable-findings.md) | A finding acts only if the conductor can confirm it by running something | proposed |
| [0008](0008-git-non-mutation.md) | The conductor and its workers never commit, stage, or mutate history | proposed |
| [0009](0009-vendor-config-isolation.md) | Each adapter runs its CLI against a conductor-owned config home | proposed |

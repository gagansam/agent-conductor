import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { capture, findBinary } from '@agent-conductor/adapter-api';
import { conductorHome, pathsFor } from '@agent-conductor/core';

const CODEX_CANDIDATES = ['codex', '/Applications/Codex.app/Contents/Resources/codex'];

const versionTuple = (v: string): number[] => (/(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1, 4) ?? ['0', '0', '0']).map(Number);
const newer = (a: string, b: string): boolean => {
  const [x, y] = [versionTuple(a), versionTuple(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/** Several Codex binaries can coexist (npm, the desktop app bundle) at very different versions. Prefer the newest. */
async function pickCodex(): Promise<{ binary: string; note: string }> {
  let best: { binary: string; version: string } | undefined;
  const seen: string[] = [];
  for (const cand of CODEX_CANDIDATES) {
    const abs = findBinary(cand);
    if (!abs) continue;
    const v = (await capture(abs, ['--version'], { env: { ...process.env, CODEX_HOME: '/nonexistent-conductor-probe' } })).stdout.trim();
    seen.push(`${abs} (${v || 'unknown'})`);
    if (!best || newer(v, best.version)) best = { binary: abs, version: v };
  }
  return best ? { binary: best.binary, note: seen.join(', ') } : { binary: 'codex', note: 'no codex binary found; install it or edit providers.codex.binary' };
}

export async function init(): Promise<number> {
  const paths = pathsFor(conductorHome());
  if (existsSync(paths.globalConfig)) {
    process.stdout.write(`${paths.globalConfig} already exists; leaving it alone.\n`);
    return 0;
  }
  const codex = await pickCodex();
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  writeFileSync(
    paths.globalConfig,
    `# agent-conductor global config. See docs/14-config-reference.md.
version: 1

providers:
  claude:
    adapter: "@agent-conductor/adapter-claude"
    binary: claude
    max_concurrent: 1          # a quota decision, not a process-count decision
    models:                    # label → whatever the CLI accepts today. "" means the CLI's own default.
      strong: opus
      fast: sonnet
      default: ""
  codex:
    adapter: "@agent-conductor/adapter-codex"
    # candidates seen: ${codex.note}
    binary: ${codex.binary}
    max_concurrent: 1
    models:
      default: ""

roles:
  implementer: { provider: claude, model: default }
  reviewer:    { provider: codex,  model: default }

loop:
  max_rounds: 3
  max_fix_attempts_per_round: 2
  max_worker_runs: 8
  max_reviewers: 1
  require_cross_vendor_review: warn   # enforce | warn | off

gates:
  default: [after_review, before_apply]
`,
  );
  process.stdout.write(`wrote ${paths.globalConfig}\nnext: conductor doctor --repo <path-to-a-repo>\n`);
  return 0;
}

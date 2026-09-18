import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempRepo {
  root: string;
  /** A scratch directory next to the repo, for conductor home / run dirs. */
  scratch: string;
  base_sha: string;
  run(args: string[], cwd?: string): string;
  write(rel: string, content: string, cwd?: string): void;
  dispose(): void;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/** A throwaway repository with one commit. Files map relative path → content. */
export function makeTempRepo(files: Record<string, string> = { 'README.md': '# temp\n' }): TempRepo {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-test-')));
  const root = join(top, 'repo');
  const scratch = join(top, 'scratch');
  mkdirSync(root, { recursive: true });
  mkdirSync(scratch, { recursive: true });

  const run = (args: string[], cwd = root): string =>
    execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (rel: string, content: string, cwd = root): void => {
    const abs = join(cwd, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  run(['init', '-q', '-b', 'main']);
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'initial']);
  const base_sha = run(['rev-parse', 'HEAD']).trim();

  return { root, scratch, base_sha, run, write, dispose: () => rmSync(top, { recursive: true, force: true }) };
}

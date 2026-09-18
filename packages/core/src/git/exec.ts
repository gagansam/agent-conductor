import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(`git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  env?: Record<string, string>;
  /** Return nonzero results instead of throwing. */
  allowFail?: boolean;
}

// Never let the operator's pager, prompts or locale change what we parse.
const BASE_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };

export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...BASE_ENV, ...opts.env }, maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        const result = { code, stdout: String(stdout), stderr: String(stderr) };
        if (code !== 0 && !opts.allowFail) reject(new GitError(args, result));
        else resolve(result);
      },
    );
  });
}

/** Stream git's stdout straight to a file. For patches, which can be large and binary. */
export function gitToFile(cwd: string, args: string[], file: string, opts: GitOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(file);
    const child = spawn('git', args, { cwd, env: { ...process.env, ...BASE_ENV, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.stdout.pipe(out);
    child.on('error', reject);
    out.on('error', reject);
    // The stream can finish before the exit code is known; wait for both.
    const exited = new Promise<number>((res) => child.on('close', (code) => res(code ?? 1)));
    const flushed = new Promise<void>((res) => out.on('finish', () => res()));
    void Promise.all([exited, flushed]).then(([code]) => {
      if (code !== 0 && !opts.allowFail) reject(new GitError(args, { code, stdout: '', stderr }));
      else resolve();
    });
  });
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim();
}

export async function currentBranch(cwd: string): Promise<string> {
  const r = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : '(detached)';
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
}

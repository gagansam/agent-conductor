/** Helpers shared by adapters for locating and interrogating a CLI binary. */
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Resolve a binary name against PATH, or verify an absolute path. Returns undefined when not found. */
export function findBinary(nameOrPath: string, envPath = process.env.PATH ?? ''): string | undefined {
  const candidates = isAbsolute(nameOrPath)
    ? [nameOrPath]
    : envPath.split(delimiter).filter(Boolean).map((dir) => join(dir, nameOrPath));
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      if (statSync(c).isFile()) return c;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a short command and capture its output. Never throws; never prompts (stdin closed). */
export function capture(
  binary: string,
  args: string[],
  opts: { timeout_ms?: number; env?: Record<string, string | undefined>; cwd?: string } = {},
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const child = execFile(
      binary,
      args,
      {
        timeout: opts.timeout_ms ?? 15_000,
        env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
        cwd: opts.cwd,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child.stdin?.end();
  });
}

/** True when `--flag` appears as a flag token in help text. */
export function helpHasFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`(^|[\\s,])${escaped}([\\s,=<\\[]|$)`, 'm').test(help);
}

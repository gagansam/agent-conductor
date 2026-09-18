import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ShellSpec {
  command: string;
  cwd: string;
  timeout_ms: number;
  stdout_path: string;
  stderr_path: string;
  env?: Record<string, string>;
  /** Aborting kills the process group. */
  signal?: AbortSignal;
}

export interface ShellResult {
  /** null ⇒ timed out or killed. */
  exit_code: number | null;
  timed_out: boolean;
  aborted: boolean;
  duration_ms: number;
}

const KILL_GRACE_MS = 5_000;

/**
 * Run a shell command the way the conductor runs every command it owns:
 * own process group, stdin closed, output teed to files, hard timeout that
 * kills the whole group. There is no `timeout(1)` on macOS; this is it.
 */
export function runShell(spec: ShellSpec): Promise<ShellResult> {
  const started = Date.now();
  mkdirSync(dirname(spec.stdout_path), { recursive: true });
  mkdirSync(dirname(spec.stderr_path), { recursive: true });
  const out = createWriteStream(spec.stdout_path);
  const err = createWriteStream(spec.stderr_path);

  return new Promise((resolve) => {
    const child = spawn(spec.command, {
      cwd: spec.cwd,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...spec.env },
    });
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const killGroup = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    };
    const terminate = (): void => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, spec.timeout_ms);
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.pipe(out);
    child.stderr.pipe(err);

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', onAbort);
      let open = 2;
      const done = (): void => {
        if (--open === 0) {
          resolve({ exit_code: timedOut || aborted ? null : code, timed_out: timedOut, aborted, duration_ms: Date.now() - started });
        }
      };
      out.end(done);
      err.end(done);
    };
    child.on('error', (e) => {
      err.write(`conductor: failed to start command: ${e.message}\n`);
      finish(127);
    });
    child.on('close', (code) => finish(code));
  });
}

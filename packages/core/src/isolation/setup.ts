import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SetupConfig } from '../config/schema.js';
import { runShell, type ShellResult } from '../proc/run-shell.js';

export interface SetupSpec {
  repo_abs: string;
  worktree_abs: string;
  setup: SetupConfig;
  log_dir_abs: string;
  signal?: AbortSignal;
}

export interface SetupResult {
  ok: boolean;
  cloned_dirs: string[];
  copied_files: string[];
  run?: ShellResult;
  detail: string;
}

/**
 * Make a fresh worktree runnable: clone dependency directories copy-on-write
 * where the filesystem allows, copy the named gitignored files, run setup.
 */
export async function setupWorktree(spec: SetupSpec): Promise<SetupResult> {
  const cloned: string[] = [];
  const copied: string[] = [];

  for (const dir of spec.setup.clone_dirs) {
    const src = join(spec.repo_abs, dir);
    const dst = join(spec.worktree_abs, dir);
    if (!existsSync(src) || existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    // APFS clonefile on macOS, reflink where available on Linux; both fall back to a plain copy.
    const cmd = process.platform === 'darwin' ? `cp -cR "${src}" "${dst}" || cp -R "${src}" "${dst}"` : `cp -R --reflink=auto "${src}" "${dst}"`;
    const r = await runShell({
      command: cmd,
      cwd: spec.worktree_abs,
      timeout_ms: spec.setup.timeout_ms,
      stdout_path: join(spec.log_dir_abs, 'clone.stdout'),
      stderr_path: join(spec.log_dir_abs, 'clone.stderr'),
      ...(spec.signal ? { signal: spec.signal } : {}),
    });
    if (r.exit_code === 0) cloned.push(dir);
  }

  for (const rel of spec.setup.copy_untracked) {
    const src = join(spec.repo_abs, rel);
    if (!existsSync(src)) continue;
    const dst = join(spec.worktree_abs, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    copied.push(rel);
  }

  if (!spec.setup.run) return { ok: true, cloned_dirs: cloned, copied_files: copied, detail: 'no setup command configured' };
  const run = await runShell({
    command: spec.setup.run,
    cwd: spec.worktree_abs,
    timeout_ms: spec.setup.timeout_ms,
    stdout_path: join(spec.log_dir_abs, 'setup.stdout'),
    stderr_path: join(spec.log_dir_abs, 'setup.stderr'),
    ...(spec.signal ? { signal: spec.signal } : {}),
  });
  const ok = run.exit_code === 0;
  return {
    ok,
    cloned_dirs: cloned,
    copied_files: copied,
    run,
    detail: ok ? 'setup ok' : run.timed_out ? `setup timed out after ${spec.setup.timeout_ms} ms` : `setup exited ${run.exit_code}`,
  };
}

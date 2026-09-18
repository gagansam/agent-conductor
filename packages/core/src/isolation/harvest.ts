import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import picomatch from 'picomatch';

export interface HarvestSpec {
  from_worktree_abs: string;
  to_worktree_abs: string;
  /** Paths named by the reviewer, relative to its worktree. */
  files: string[];
  allowed_paths: string[];
  max_files: number;
  /** Files the implementer changed. A reproduction may not overwrite the work under review. */
  implementer_changed: string[];
  /** A copy is kept here regardless of outcome, for the record. */
  keep_dir_abs: string;
}

export type HarvestResult = { ok: true; files: string[] } | { ok: false; reason: string };

function safeRel(p: string): string | null {
  if (!p || isAbsolute(p)) return null;
  const n = normalize(p);
  if (n === '..' || n.startsWith(`..${sep}`) || n.startsWith('.conductor')) return null;
  return n.split(sep).join('/');
}

/**
 * Nothing leaves a reviewer's worktree except the files its verdict names,
 * and only when they sit under the repo's allowed reproduction paths.
 */
export function harvest(spec: HarvestSpec): HarvestResult {
  if (spec.files.length > spec.max_files) {
    return { ok: false, reason: `reproduction names ${spec.files.length} files; the limit is ${spec.max_files}` };
  }
  const allowed = picomatch(spec.allowed_paths, { dot: true });
  const changed = new Set(spec.implementer_changed);
  const rels: string[] = [];
  for (const f of spec.files) {
    const rel = safeRel(f);
    if (!rel) return { ok: false, reason: `unsafe path "${f}"` };
    if (!allowed(rel)) return { ok: false, reason: `"${rel}" is outside the allowed reproduction paths (${spec.allowed_paths.join(', ')})` };
    if (changed.has(rel)) return { ok: false, reason: `"${rel}" was changed by the implementer; a reproduction may not overwrite it` };
    const src = join(spec.from_worktree_abs, rel);
    if (!existsSync(src)) return { ok: false, reason: `"${rel}" does not exist in the reviewer's worktree` };
    const st = lstatSync(src);
    if (!st.isFile() || st.isSymbolicLink()) return { ok: false, reason: `"${rel}" is not a regular file` };
    rels.push(rel);
  }
  for (const rel of rels) {
    const src = join(spec.from_worktree_abs, rel);
    for (const root of [spec.keep_dir_abs, spec.to_worktree_abs]) {
      const dst = join(root, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
  return { ok: true, files: rels };
}

/** Remove harvested files from a worktree (after a refuted reproduction). */
export function unharvest(worktree_abs: string, files: string[]): void {
  for (const rel of files) rmSync(join(worktree_abs, rel), { force: true });
}

/** Restore harvested files from the kept copy, so an implementer cannot "fix" a reproduction by editing it. */
export function restoreHarvested(worktree_abs: string, keep_dir_abs: string, files: string[]): string[] {
  const tampered: string[] = [];
  for (const rel of files) {
    const kept = join(keep_dir_abs, rel);
    const live = join(worktree_abs, rel);
    if (!existsSync(kept)) continue;
    const same = existsSync(live) && readFileSync(kept).equals(readFileSync(live));
    if (!same) {
      tampered.push(rel);
      mkdirSync(dirname(live), { recursive: true });
      copyFileSync(kept, live);
    }
  }
  return tampered;
}

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Paths } from './load.js';

/**
 * Repositories the conductor has worked with, by name, so `--repo api` and a
 * task's `repo: fieldscope-platform-api` work from any folder. A plain JSON
 * file next to the database: the operator's config.yaml is theirs to edit and
 * is never rewritten.
 */
export type RepoRegistry = Record<string, string>;

const registryFile = (paths: Paths): string => join(paths.home, 'repos.json');

export function loadRepoRegistry(paths: Paths): RepoRegistry {
  const f = registryFile(paths);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as RepoRegistry;
  } catch {
    return {};
  }
}

/** Remember a repo under its folder name (or parent-folder name on a clash). Returns the name it is known by. */
export function registerRepo(paths: Paths, repo_abs: string): string {
  const reg = loadRepoRegistry(paths);
  const existing = Object.entries(reg).find(([, p]) => p === repo_abs);
  if (existing) return existing[0];
  let name = basename(repo_abs);
  if (reg[name] && reg[name] !== repo_abs) name = `${basename(dirname(repo_abs))}-${name}`;
  for (let n = 2; reg[name] && reg[name] !== repo_abs; n++) name = `${basename(repo_abs)}-${n}`;
  reg[name] = repo_abs;
  mkdirSync(paths.home, { recursive: true });
  writeFileSync(registryFile(paths), JSON.stringify(reg, null, 2) + '\n');
  return name;
}

export function repoName(paths: Paths, repo_abs: string): string {
  return Object.entries(loadRepoRegistry(paths)).find(([, p]) => p === repo_abs)?.[0] ?? basename(repo_abs);
}

/** A name from the registry, else a path relative to `base_dir`. Undefined when it is neither. */
export function lookupRepoRef(paths: Paths, ref: string, base_dir: string): string | undefined {
  const reg = loadRepoRegistry(paths);
  if (reg[ref]) return reg[ref];
  const p = isAbsolute(ref) ? ref : resolve(base_dir, ref);
  return existsSync(p) ? p : undefined;
}

/** Git repositories directly inside `dir`: a workspace folder like field-scope/repo. */
export function childRepos(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.startsWith('.') && existsSync(join(dir, e, '.git')))
    .sort()
    .map((e) => join(dir, e));
}

import { basename } from 'node:path';
import { UserError, childRepos, conductorHome, loadGlobalConfig, loadRepoRegistry, lookupRepoRef, pathsFor, repoRoot, Store, type GlobalConfig, type Paths } from '@agent-conductor/core';
import { c } from './print.js';
import type { Prompter } from './prompt.js';

export interface Context {
  paths: Paths;
  global: GlobalConfig;
  store: Store;
}

export function openContext(): Context {
  const paths = pathsFor(conductorHome());
  const global = loadGlobalConfig(paths.globalConfig);
  return { paths, global, store: Store.open(paths.db) };
}

export interface RepoChoice {
  paths: Paths;
  /** --repo: a known name, or a path. */
  flag?: string | undefined;
  /** A task file's `repo:`, resolved relative to the task file's folder. */
  taskHint?: { ref: string; base_dir: string } | undefined;
  /** Lets a workspace folder ask which repository is meant. */
  prompter?: Prompter | undefined;
}

const root = async (p: string): Promise<string | undefined> => repoRoot(p).catch(() => undefined);

function knownRepos(paths: Paths): string {
  const names = Object.keys(loadRepoRegistry(paths));
  return names.length ? `. Known repositories: ${names.join(', ')}` : '';
}

/**
 * Which repository a command works on. First match wins: --repo, the task's
 * own repo:, the repository containing this folder, then (in a folder that
 * holds several repositories) a question.
 */
export async function chooseRepo(o: RepoChoice): Promise<string> {
  if (o.flag) {
    const p = lookupRepoRef(o.paths, o.flag, process.cwd());
    const r = p && (await root(p));
    if (!r) throw new UserError(`--repo ${o.flag}: not a known repository name or a path to a git repository${knownRepos(o.paths)}`);
    return r;
  }
  if (o.taskHint) {
    const p = lookupRepoRef(o.paths, o.taskHint.ref, o.taskHint.base_dir);
    const r = p && (await root(p));
    if (!r) throw new UserError(`the task's repo "${o.taskHint.ref}" is not a known repository name or a path to a git repository${knownRepos(o.paths)}`);
    return r;
  }
  const here = await root(process.cwd());
  if (here) return here;

  const children = childRepos(process.cwd());
  if (children.length && o.prompter?.interactive) {
    process.stdout.write(`\n${c.bold('Which repository?')}\n`);
    children.forEach((r, i) => process.stdout.write(`  ${i + 1}. ${basename(r)}\n`));
    const pick = await o.prompter.ask('  number', children.length === 1 ? '1' : '', (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= children.length ? undefined : `a number from 1 to ${children.length}`));
    return children[Number(pick) - 1]!;
  }
  const here_ = process.cwd();
  const hint = children.length ? `; repositories in this folder: ${children.map((r) => basename(r)).join(', ')}` : '';
  throw new UserError(`${here_} is not inside a git repository. Use --repo <name or path>${hint}${knownRepos(o.paths)}`);
}

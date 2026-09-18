import { conductorHome, loadGlobalConfig, pathsFor, repoRoot, Store, type GlobalConfig, type Paths } from '@agent-conductor/core';
import { resolve } from 'node:path';

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

/** --repo, or the git repository containing the current directory. */
export async function resolveRepo(flag: string | undefined): Promise<string> {
  try {
    return await repoRoot(resolve(flag ?? process.cwd()));
  } catch {
    throw new Error(`${resolve(flag ?? process.cwd())} is not inside a git repository (use --repo <path>)`);
  }
}

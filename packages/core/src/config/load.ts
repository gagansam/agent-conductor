import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import type { RoleTarget } from '../contracts/task.js';
import { GlobalConfigSchema, RepoConfigSchema, type GlobalConfig, type RepoConfig } from './schema.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length ? `${message}\n  - ${issues.join('\n  - ')}` : message);
    this.name = 'ConfigError';
  }
}

/** Where the database, runs, worktrees and vendor homes live. */
export function conductorHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CONDUCTOR_HOME ?? join(homedir(), '.conductor'));
}

export interface Paths {
  home: string;
  db: string;
  runs: string;
  worktrees: string;
  vendor: string;
  hooks: string;
  stopFile: string;
  globalConfig: string;
  tasks: string;
}

export function pathsFor(home: string): Paths {
  return {
    home,
    db: join(home, 'conductor.db'),
    runs: join(home, 'runs'),
    worktrees: join(home, 'worktrees'),
    vendor: join(home, 'vendor'),
    hooks: join(home, 'hooks'),
    stopFile: join(home, 'STOP'),
    globalConfig: join(home, 'config.yaml'),
    tasks: join(home, 'tasks'),
  };
}

function loadYaml<S extends z.ZodType>(file: string, schema: S, what: string): z.output<S> {
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${what}: cannot read or parse ${file}: ${(e as Error).message}`, file);
  }
  const r = schema.safeParse(doc ?? {});
  if (!r.success) {
    throw new ConfigError(
      `${what}: ${file} is invalid`,
      file,
      r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return r.data;
}

export function loadGlobalConfig(file: string): GlobalConfig {
  if (!existsSync(file)) throw new ConfigError(`global config not found at ${file}; run \`conductor init\``, file);
  const cfg = loadYaml(file, GlobalConfigSchema, 'global config');
  const issues: string[] = [];
  for (const [role, target] of Object.entries(cfg.roles)) issues.push(...checkTarget(cfg, `roles.${role}`, target));
  if (!cfg.roles.implementer) issues.push('roles.implementer is required');
  if (issues.length) throw new ConfigError('global config is inconsistent', file, issues);
  return cfg;
}

export function repoConfigPath(repo: string): string {
  return join(repo, '.conductor', 'config.yaml');
}

/** A repo without .conductor/config.yaml gets defaults: no setup, no verification steps. */
export function loadRepoConfig(repo: string): RepoConfig {
  const file = repoConfigPath(repo);
  if (!existsSync(file)) return RepoConfigSchema.parse({ version: 1 });
  return loadYaml(file, RepoConfigSchema, 'repo config');
}

export function checkTarget(cfg: GlobalConfig, where: string, target: RoleTarget): string[] {
  const issues: string[] = [];
  const check = (provider: string, model: string, at: string): void => {
    const p = cfg.providers[provider];
    if (!p) issues.push(`${at}: unknown provider "${provider}"`);
    else if (!(model in p.models)) issues.push(`${at}: provider "${provider}" has no model label "${model}"`);
  };
  check(target.provider, target.model, where);
  target.fallback.forEach((f, i) => check(f.provider, f.model, `${where}.fallback[${i}]`));
  return issues;
}

export interface ResolvedTarget extends RoleTarget {
  /** The config key this came from: implementer, reviewer, reviewer_2 … */
  slot: string;
  model_id: string;
}

/** global roles → repo routing → task routing. Labels resolve to vendor ids here and nowhere else. */
export function resolveRoles(
  global: GlobalConfig,
  repo: RepoConfig,
  taskRouting: Record<string, RoleTarget>,
): { implementer: ResolvedTarget; reviewers: ResolvedTarget[]; reproducer?: ResolvedTarget } {
  const merged: Record<string, RoleTarget> = { ...global.roles, ...repo.routing, ...taskRouting };
  const issues = Object.entries(merged).flatMap(([slot, t]) => checkTarget(global, `routing.${slot}`, t));
  if (issues.length) throw new ConfigError('role routing is inconsistent', '(merged routing)', issues);
  const resolveOne = (slot: string, t: RoleTarget): ResolvedTarget => ({
    ...t,
    slot,
    model_id: global.providers[t.provider]!.models[t.model]!,
  });
  const implementer = merged.implementer;
  if (!implementer) throw new ConfigError('no implementer role configured', '(merged routing)');
  const reviewers = Object.keys(merged)
    .filter((k) => /^reviewer(_\d+)?$/.test(k))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((k) => resolveOne(k, merged[k]!));
  const reproducer = merged.reproducer ? resolveOne('reproducer', merged.reproducer) : undefined;
  return { implementer: resolveOne('implementer', implementer), reviewers, ...(reproducer ? { reproducer } : {}) };
}

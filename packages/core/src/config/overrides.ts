import type { RoleTarget, TaskSpec } from '../contracts/task.js';
import { ConfigError } from './load.js';
import type { GlobalConfig, RepoConfig } from './schema.js';

export interface RoleSpec {
  provider: string;
  /** A model label from config, or a raw vendor model id. */
  model: string;
  effort?: string;
}

const SPEC = /^([^/:\s]+)\/([^:\s]+)(?::([^:\s]+))?$/;

/** `claude/opus`, `claude/opus:high`, `codex/gpt-5.1-codex:xhigh`. */
export function parseRoleSpec(spec: string): RoleSpec {
  const m = SPEC.exec(spec.trim());
  if (!m) throw new ConfigError(`"${spec}" is not a role spec; expected <provider>/<model>[:<effort>], e.g. claude/opus:high`, '(command line)');
  return { provider: m[1]!, model: m[2]!, ...(m[3] ? { effort: m[3] } : {}) };
}

export interface RoleOverrides {
  implementer?: string;
  /** `none` runs implement → verify only. */
  reviewer?: string;
}

export interface AppliedOverrides {
  global: GlobalConfig;
  task: TaskSpec;
  notes: string[];
}

/**
 * Command-line role choices, applied on top of global roles, repo routing and
 * task routing. They are written into the task's routing, so the stored task
 * records what actually ran.
 *
 * A model that is not a label in config is passed through as a raw vendor id,
 * so a new model version needs no config edit. Effort carries over from the
 * configured role only when the provider stays the same: effort values mean
 * different things to different vendors.
 */
export function applyRoleOverrides(global: GlobalConfig, repo: RepoConfig, task: TaskSpec, overrides: RoleOverrides): AppliedOverrides {
  const notes: string[] = [];
  const providers = Object.fromEntries(Object.entries(global.providers).map(([k, p]) => [k, { ...p, models: { ...p.models } }]));
  const routing: Record<string, RoleTarget> = { ...task.routing };
  const budget = { ...task.budget };
  const effective = (slot: string): RoleTarget | undefined => task.routing[slot] ?? repo.routing[slot] ?? global.roles[slot];

  for (const slot of ['implementer', 'reviewer'] as const) {
    const raw = overrides[slot]?.trim();
    if (!raw) continue;
    if (raw === 'none') {
      if (slot === 'implementer') throw new ConfigError('--implementer cannot be "none"', '(command line)');
      budget.max_reviewers = 0;
      continue;
    }
    const spec = parseRoleSpec(raw);
    const provider = providers[spec.provider];
    if (!provider) {
      throw new ConfigError(`--${slot}: unknown provider "${spec.provider}"; configured providers: ${Object.keys(providers).join(', ')}`, '(command line)');
    }
    if (!(spec.model in provider.models)) {
      provider.models[spec.model] = spec.model;
      notes.push(`${slot}: "${spec.model}" is not a model label for ${spec.provider} (labels: ${Object.keys(global.providers[spec.provider]!.models).join(', ') || 'none'}); passing it to the CLI as a model id`);
    }
    const current = effective(slot);
    const effort = spec.effort ?? (current?.provider === spec.provider ? current.effort : undefined);
    routing[slot] = { provider: spec.provider, model: spec.model, ...(effort ? { effort } : {}), optional: false, fallback: [] };
    if (slot === 'reviewer' && budget.max_reviewers === 0) budget.max_reviewers = 1;
  }

  return { global: { ...global, providers }, task: { ...task, routing, budget }, notes };
}

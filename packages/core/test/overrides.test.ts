import { describe, expect, it } from 'vitest';
import { ConfigError, resolveRoles } from '../src/config/load.js';
import { applyRoleOverrides, parseRoleSpec } from '../src/config/overrides.js';
import { GlobalConfigSchema, RepoConfigSchema } from '../src/config/schema.js';
import { parseTask } from '../src/task/parse.js';

const global = GlobalConfigSchema.parse({
  version: 1,
  providers: {
    claude: { adapter: 'a', models: { opus: 'opus', fable: 'fable' } },
    codex: { adapter: 'b', models: { default: '' } },
  },
  roles: { implementer: { provider: 'claude', model: 'opus', effort: 'high' }, reviewer: { provider: 'codex', model: 'default' } },
});
const repo = RepoConfigSchema.parse({ version: 1 });
const task = parseTask('---\ntitle: t\nacceptance: [{ id: A, text: a }]\n---\nbody', { repo_abs: '/r', global });

describe('role specs', () => {
  it('parses provider/model[:effort]', () => {
    expect(parseRoleSpec('claude/opus')).toEqual({ provider: 'claude', model: 'opus' });
    expect(parseRoleSpec(' codex/gpt-5.1-codex:xhigh ')).toEqual({ provider: 'codex', model: 'gpt-5.1-codex', effort: 'xhigh' });
  });

  it('rejects anything else', () => {
    for (const bad of ['claude', 'claude/', '/opus', 'claude/opus:', 'claude/opus:high:x', 'claude/op us']) {
      expect(() => parseRoleSpec(bad), bad).toThrow(ConfigError);
    }
  });
});

describe('applying overrides', () => {
  it('overrides roles and records them in the task', () => {
    const r = applyRoleOverrides(global, repo, task, { implementer: 'claude/fable:max', reviewer: 'codex/default:high' });
    const roles = resolveRoles(r.global, repo, r.task.routing);
    expect([roles.implementer.provider, roles.implementer.model_id, roles.implementer.effort]).toEqual(['claude', 'fable', 'max']);
    expect([roles.reviewers[0]!.provider, roles.reviewers[0]!.model_id, roles.reviewers[0]!.effort]).toEqual(['codex', '', 'high']);
    expect(r.task.routing.implementer?.model).toBe('fable');
    expect(r.notes).toEqual([]);
  });

  it('keeps configured effort when only the model changes, and drops it across providers', () => {
    const same = applyRoleOverrides(global, repo, task, { implementer: 'claude/fable' });
    expect(same.task.routing.implementer?.effort).toBe('high');
    const other = applyRoleOverrides(global, repo, task, { implementer: 'codex/default' });
    expect(other.task.routing.implementer?.effort).toBeUndefined();
  });

  it('passes an unknown model through as a raw id, with a note, without touching the loaded config', () => {
    const r = applyRoleOverrides(global, repo, task, { implementer: 'claude/claude-fable-5' });
    expect(resolveRoles(r.global, repo, r.task.routing).implementer.model_id).toBe('claude-fable-5');
    expect(r.notes[0]).toContain('passing it to the CLI as a model id');
    expect('claude-fable-5' in global.providers.claude!.models).toBe(false);
  });

  it('turns review off with --reviewer none', () => {
    const r = applyRoleOverrides(global, repo, task, { reviewer: 'none' });
    expect(r.task.budget.max_reviewers).toBe(0);
    expect(r.notes).toEqual([]);
    expect(() => applyRoleOverrides(global, repo, task, { implementer: 'none' })).toThrow(ConfigError);
  });

  it('rejects an unknown provider and names the configured ones', () => {
    expect(() => applyRoleOverrides(global, repo, task, { reviewer: 'gemini/pro' })).toThrow(/configured providers: claude, codex/);
  });

  it('changes nothing when no flags are given', () => {
    const r = applyRoleOverrides(global, repo, task, {});
    expect(r.task).toEqual(task);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { GlobalConfig } from '../config/schema.js';
import { TaskFileSchema, type TaskSpec } from '../contracts/task.js';
import { ulid } from '../ids.js';

export class TaskError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(issues.length ? `${message}\n  - ${issues.join('\n  - ')}` : message);
    this.name = 'TaskError';
  }
}

/** Split `---` YAML frontmatter from a markdown body. */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!m) return { frontmatter: null, body: text };
  return { frontmatter: m[1] ?? '', body: m[2] ?? '' };
}

export interface ParseTaskOptions {
  repo_abs: string;
  global: GlobalConfig;
  id?: string;
}

/** task.md → a frozen TaskSpec with config defaults applied. */
export function parseTask(text: string, opts: ParseTaskOptions): TaskSpec {
  const { frontmatter, body } = splitFrontmatter(text);
  if (frontmatter === null) throw new TaskError('task file has no YAML frontmatter (expected a leading `---` block)');
  let doc: unknown;
  try {
    doc = parseYaml(frontmatter);
  } catch (e) {
    throw new TaskError(`task frontmatter is not valid YAML: ${(e as Error).message}`);
  }
  const r = TaskFileSchema.safeParse(doc ?? {});
  if (!r.success) {
    throw new TaskError('task frontmatter is invalid', r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const f = r.data;
  const description = body.trim();
  if (!description) throw new TaskError('task has no description (the markdown body is empty)');
  const ids = f.acceptance.map((a) => a.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new TaskError(`duplicate acceptance criterion id "${dup}"`);

  const loop = opts.global.loop;
  return {
    schema_version: 1,
    id: opts.id ?? ulid(),
    title: f.title,
    kind: f.kind,
    repo: { path_abs: resolve(opts.repo_abs), ...(f.base_ref ? { base_ref: f.base_ref } : {}) },
    description,
    acceptance: f.acceptance,
    constraints: f.constraints,
    touch_hint: f.touch_hint,
    context_files: f.context_files,
    verification: f.verification,
    budget: {
      max_rounds: f.budget.max_rounds ?? loop.max_rounds,
      max_fix_attempts_per_round: f.budget.max_fix_attempts_per_round ?? loop.max_fix_attempts_per_round,
      max_worker_runs: f.budget.max_worker_runs ?? loop.max_worker_runs,
      max_wall_ms: f.budget.max_wall_ms ?? loop.max_wall_ms,
      max_reviewers: f.budget.max_reviewers ?? loop.max_reviewers,
    },
    routing: f.routing,
    gates: f.gates ?? opts.global.gates.default,
    clarify: f.clarify ?? opts.global.loop.clarify,
    reference: f.reference,
  };
}

export function parseTaskFile(file: string, opts: ParseTaskOptions): TaskSpec {
  return parseTask(readFileSync(file, 'utf8'), opts);
}

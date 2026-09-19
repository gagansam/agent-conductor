import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Paths } from '../config/load.js';
import type { AcceptanceCriterion, TaskKind } from '../contracts/task.js';
import { UserError } from '../errors.js';
import { splitFrontmatter } from './parse.js';

/** What `conductor task` writes: the fields an operator sets, plus the repo the task belongs to. */
export interface TaskFileContent {
  title: string;
  kind: TaskKind;
  repo?: string;
  description: string;
  acceptance: AcceptanceCriterion[];
  constraints: string[];
  touch_hint: string[];
  context_files: string[];
}

export function renderTaskFile(t: TaskFileContent): string {
  const front: Record<string, unknown> = { title: t.title, kind: t.kind };
  if (t.repo) front.repo = t.repo;
  front.acceptance = t.acceptance.map((a) => ({ id: a.id, text: a.text, ...(a.check ? { check: a.check } : {}) }));
  if (t.constraints.length) front.constraints = t.constraints;
  if (t.touch_hint.length) front.touch_hint = t.touch_hint;
  if (t.context_files.length) front.context_files = t.context_files;
  return `---\n${stringifyYaml(front, { lineWidth: 0 }).trimEnd()}\n---\n\n${t.description.trim()}\n`;
}

/** A one-sentence task: `conductor run "Add divide to lib/math.js"`. The repo's checks and the review still apply. */
export function sentenceTask(sentence: string): string {
  const text = sentence.trim().replace(/\s+/g, ' ');
  const title = text.length > 80 ? `${text.slice(0, 77).trimEnd()}…` : text;
  return renderTaskFile({ title, kind: 'feature', description: sentence.trim(), acceptance: [{ id: 'AC1', text }], constraints: [], touch_hint: [], context_files: [] });
}

/** The `repo:` a task file names, if any, without validating anything else. */
export function taskRepoHint(text: string): string | undefined {
  const { frontmatter } = splitFrontmatter(text);
  if (frontmatter === null) return undefined;
  try {
    const doc = parseYaml(frontmatter) as { repo?: unknown } | null;
    return typeof doc?.repo === 'string' && doc.repo.trim() ? doc.repo.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function slugify(title: string): string {
  const full = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (full.length <= 50) return full || 'task';
  // Cut at a word boundary: "...-next-to-existing" rather than "...-next-to-existing-ari".
  const cut = full.slice(0, 51);
  return cut.slice(0, cut.lastIndexOf('-') > 20 ? cut.lastIndexOf('-') : 50) || 'task';
}

/** ~/.conductor/tasks/<repo>/<yyyy-mm-dd>-<slug>.md, never overwriting an existing task. */
export function savedTaskPath(paths: Paths, repo: string, title: string, now = new Date()): string {
  const dir = join(paths.home, 'tasks', repo);
  const stem = `${now.toISOString().slice(0, 10)}-${slugify(title)}`;
  let file = join(dir, `${stem}.md`);
  for (let n = 2; existsSync(file); n++) file = join(dir, `${stem}-${n}.md`);
  return file;
}

export function writeTaskFile(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export interface SavedTask {
  name: string;
  repo: string;
  path: string;
  title: string;
  modified: Date;
}

export function listSavedTasks(paths: Paths, repo?: string): SavedTask[] {
  const root = join(paths.home, 'tasks');
  if (!existsSync(root)) return [];
  const out: SavedTask[] = [];
  for (const rel of readdirSync(root, { recursive: true }) as string[]) {
    if (!rel.endsWith('.md')) continue;
    const path = join(root, rel);
    const taskRepo = basename(dirname(path));
    if (repo && taskRepo !== repo) continue;
    const text = readFileSync(path, 'utf8');
    const title = /^title:\s*(.+)$/m.exec(splitFrontmatter(text).frontmatter ?? '')?.[1]?.replace(/^["']|["']$/g, '') ?? basename(path, '.md');
    out.push({ name: basename(path, '.md'), repo: taskRepo, path, title, modified: statSync(path).mtime });
  }
  return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** By exact name, else by name without its date prefix. Throws on ambiguity. */
export function findSavedTask(paths: Paths, ref: string): SavedTask | undefined {
  const all = listSavedTasks(paths);
  const exact = all.filter((t) => t.name === ref);
  const matches = exact.length ? exact : all.filter((t) => t.name.replace(/^\d{4}-\d{2}-\d{2}-/, '') === ref || t.name.endsWith(`-${ref}`));
  if (matches.length > 1) throw new UserError(`"${ref}" matches ${matches.length} saved tasks: ${matches.map((t) => `${t.repo}/${t.name}`).join(', ')}`);
  return matches[0];
}

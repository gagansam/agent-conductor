import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import { outputSpec, PACK_DIR_REL, type OutputKind } from '../contracts/json-schema.js';
import type { ContextPack, FileExcerpt, PackBase, RoleAddendum } from '../contracts/pack.js';
import type { FixTarget } from '../contracts/round.js';
import type { Role, TaskSpec } from '../contracts/task.js';
import type { ImplementerReport } from '../contracts/work-product.js';
import { git } from '../git/exec.js';
import { resetConductorDirs } from '../isolation/worktree.js';

const BUILTIN_TEMPLATES = fileURLToPath(new URL('../../templates/', import.meta.url));
const MAX_EXCERPT_BYTES = 64 * 1024;

/** Stable stringify: object keys sorted, so the hash depends on content and nothing else. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Hashes only the base, so two workers in the same role and round provably saw identical context. */
export function packId(base: PackBase): string {
  return createHash('sha256').update(canonical(base)).digest('hex');
}

/** Inline the task's context_files from the worktree. Globs match tracked files; literal paths may be absolute. */
export async function loadExcerpts(worktree: string, patterns: string[]): Promise<FileExcerpt[]> {
  if (!patterns.length) return [];
  const out: FileExcerpt[] = [];
  const tracked = (await git(worktree, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean);
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const abs = pattern.startsWith('/');
    const match = picomatch(pattern, { dot: true });
    const matches = abs ? (existsSync(pattern) ? [pattern] : []) : tracked.filter((f) => match(f)).sort();
    for (const m of matches) {
      if (seen.has(m)) continue;
      seen.add(m);
      const buf = readFileSync(abs ? m : join(worktree, m));
      const clipped = buf.length > MAX_EXCERPT_BYTES;
      const content = buf.subarray(0, MAX_EXCERPT_BYTES).toString('utf8') + (clipped ? '\n… (truncated by conductor)\n' : '');
      out.push({ path: m, content, sha256: createHash('sha256').update(buf).digest('hex') });
    }
  }
  return out;
}

const fence = (content: string, lang = ''): string => {
  const ticks = content.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${content.replace(/\n$/, '')}\n${ticks}`;
};

export function renderTask(task: TaskSpec): string {
  const lines = [`# Task: ${task.title}`, '', `Kind: ${task.kind}`, '', '## Description', '', task.description, '', '## Acceptance criteria', ''];
  for (const ac of task.acceptance) {
    const how = !ac.check ? 'no automatic check' : ac.check.kind === 'manual' ? 'judged by the operator' : `checked by running \`${ac.check.run}\``;
    lines.push(`- **${ac.id}** — ${ac.text} _(${how})_`);
  }
  if (task.constraints.length) lines.push('', '## Constraints', '', ...task.constraints.map((c) => `- ${c}`));
  if (task.touch_hint.length) lines.push('', '## Files expected to change', '', ...task.touch_hint.map((c) => `- \`${c}\``), '', 'Changing files outside these is allowed when necessary, and will be flagged for the operator.');
  if (task.reference.length) lines.push('', '## References', '', ...task.reference.map((c) => `- ${c}`));
  return lines.join('\n') + '\n';
}

function renderInstructions(base: PackBase, role: Role): string {
  const docs = base.instructions.filter((d) => d.applies_to.includes(role));
  if (!docs.length) return '# Repository instructions\n\nThis repository provides no instruction documents.\n';
  const parts = ['# Repository instructions', '', 'These are the repository\'s own engineering instructions, inlined verbatim. They apply to your work.', ''];
  for (const d of docs) parts.push(`---\n\n<!-- source: ${d.source} -->\n\n## ${d.title}\n\n${d.body}\n`);
  return parts.join('\n');
}

function renderContext(base: PackBase): string {
  const parts = [
    '# Context',
    '',
    `- Base commit: \`${base.repo.base_sha}\` (branch \`${base.repo.branch}\`)`,
    '- The repository root is your current directory.',
    '',
    '## Checks the orchestrator will run on the result',
    '',
    base.repo.verification_summary,
    '',
  ];
  if (base.decisions.length) {
    parts.push('## Decisions already made (binding)', '', 'Follow these. A change that contradicts one is wrong even if every check passes.', '', ...base.decisions.map((d) => `- ${d}`), '');
  }
  if (base.files.length) {
    parts.push('## Files the operator attached', '');
    for (const f of base.files) parts.push(`### ${f.path}`, '', fence(f.content), '');
  }
  return parts.join('\n');
}

function renderPrior(base: PackBase): string {
  const parts = ['# Earlier rounds', ''];
  for (const p of base.prior) {
    parts.push(`## Round ${p.round}`, '', `Implementer summary: ${p.implementer_report_summary || '(none)'}`, '');
    parts.push(`Verification: ${p.verification.passed ? 'passed' : 'FAILED'}`);
    for (const s of p.verification.failed_steps) parts.push('', `### Failed step \`${s.step_id}\``, '', fence(s.tail));
    if (p.confirmed_findings.length) {
      parts.push('', '### Confirmed findings', '');
      for (const f of p.confirmed_findings) parts.push(`- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.claim}`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

export function renderFixTargets(targets: FixTarget[]): string {
  return targets
    .map((t, i) => {
      const lines = [`### ${i + 1}. ${t.summary}`, '', t.detail.trim()];
      const r = t.reproduction;
      if (r && (r.kind === 'test' || r.kind === 'command')) {
        lines.push('', `The orchestrator re-checks this by running: \`${r.run}\``);
        if (r.kind === 'test') lines.push(`Reproduction files (do not edit or delete them; they are restored before checking): ${r.files.map((f) => `\`${f}\``).join(', ')}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

export interface RenderPackSpec {
  base: PackBase;
  pack_id: string;
  run_id: string;
  round: number;
  addendum: RoleAddendum;
  worktree_abs: string;
  /** A copy of the rendered pack is kept here for the record. */
  keep_dir_abs: string;
  /** Repo-level template overrides, if configured. */
  templates_dir_abs?: string;
  /** Reviewer only. */
  diff_path_abs?: string;
  report?: ImplementerReport | null;
  /** Prompt template name, when not the role's own (e.g. "clarify"). */
  template?: string;
  /** Output document, when not the role's own (e.g. "questions"). */
  output_kind?: OutputKind;
  /** Implementer only: whether it may stop to ask, and how many stops it has left. */
  asking?: { attended: boolean; stops_left: number };
}

/** How the implementer should handle uncertainty: decide small things, stop only when a wrong guess wastes the work. */
export function askingSection(asking: { attended: boolean; stops_left: number } | undefined): string {
  const record =
    'Decide small things yourself: anything cheap to change later, such as wording, a default value, or which of two equivalent helpers to use. Record each such judgment call under `decisions_made` in your report, with the alternatives you rejected. Keep each `question` to one short sentence and put your reasoning under `why`.';
  if (!asking || !asking.attended) {
    return `## When you are unsure\n\nNobody can answer questions during this run. ${record} Decide the big ones yourself too, choosing what you would recommend, and record them the same way. Leave \`blocking_questions\` empty.`;
  }
  if (asking.stops_left <= 0) {
    return `## When you are unsure\n\nYou have used every stop allowed in this run, so you cannot ask again. ${record} Decide the big ones yourself too, choosing what you would recommend, and record them the same way. Leave \`blocking_questions\` empty.`;
  }
  return [
    '## When you are unsure',
    '',
    `${record} The operator reviews them before the code is reviewed and may overrule some.`,
    '',
    'Stop only for a question where a wrong guess would force redoing most of the work: which module, file or layer the change belongs in, the shape of a data model or API, or anything that contradicts the task as written. Then do not guess. Write your report with the question under `blocking_questions`, giving the options and your recommended answer as `default`, and end your turn. Keep the work you have done so far in the tree. You will be resumed in this same session with the answer.',
    '',
    'Do not hedge by building more than one alternative so that you do not have to choose, such as adding the same function to two modules. Noticing that you would need to hedge is the signal to stop.',
    '',
    `You may stop at most ${asking.stops_left} more time${asking.stops_left === 1 ? '' : 's'} in this run.`,
  ].join('\n');
}

export interface RenderedPack {
  prompt: string;
  prompt_sha256: string;
  prompt_path_abs: string;
  pack: ContextPack;
}

function loadTemplate(template: string, overrideDir?: string): string {
  const name = `${template}.md`;
  if (overrideDir && existsSync(join(overrideDir, name))) return readFileSync(join(overrideDir, name), 'utf8');
  return readFileSync(join(BUILTIN_TEMPLATES, name), 'utf8');
}

const fill = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => (key in vars ? vars[key]! : whole));

/** Write the pack into the worktree and return the prompt. Files are the interface (ADR-0006). */
export function renderPack(spec: RenderPackSpec): RenderedPack {
  const role = spec.addendum.role;
  const out = outputSpec(spec.output_kind ?? role);
  const dir = join(spec.worktree_abs, PACK_DIR_REL);
  resetConductorDirs(spec.worktree_abs, ['pack', 'out']);

  const pack: ContextPack = { ...spec.base, pack_id: spec.pack_id, run_id: spec.run_id, round: spec.round, addendum: spec.addendum };
  const files: Record<string, string> = {
    'TASK.md': renderTask(spec.base.task),
    'INSTRUCTIONS.md': renderInstructions(spec.base, role),
    'CONTEXT.md': renderContext(spec.base),
    'OUTPUT-SCHEMA.json': JSON.stringify(out.json_schema, null, 2) + '\n',
    'pack.json': JSON.stringify(pack, null, 2) + '\n',
  };
  if (spec.base.prior.length) files['PRIOR.md'] = renderPrior(spec.base);
  if (spec.addendum.role === 'reviewer') {
    files['REPORT.json'] = JSON.stringify(spec.report ?? { note: 'The implementer did not produce a valid report.' }, null, 2) + '\n';
  }

  const fixTargets = spec.addendum.role === 'implementer' ? spec.addendum.fix_targets : [];
  const reproPaths = spec.addendum.role === 'implementer' ? [] : spec.addendum.repro_allowed_paths;
  const prompt = fill(loadTemplate(spec.template ?? role, spec.templates_dir_abs), {
    title: spec.base.task.title,
    round: String(spec.round),
    output_path: out.path_rel,
    pack_dir: PACK_DIR_REL,
    prior_line: spec.base.prior.length ? `- \`${PACK_DIR_REL}/PRIOR.md\` — what happened in earlier rounds\n` : '',
    work_section: fixTargets.length
      ? `The task has already been implemented in this working tree, but these problems remain. Fix exactly these, and nothing else:\n\n${renderFixTargets(fixTargets)}`
      : 'Implement the task described in TASK.md in this working tree.',
    repro_allowed_paths: reproPaths.map((p) => `\`${p}\``).join(', ') || '(none configured)',
    asking_section: askingSection(spec.asking),
  });
  files['PROMPT.md'] = prompt;

  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  if (spec.addendum.role === 'reviewer' && spec.diff_path_abs) copyFileSync(spec.diff_path_abs, join(dir, 'DIFF.patch'));

  mkdirSync(spec.keep_dir_abs, { recursive: true });
  cpSync(dir, spec.keep_dir_abs, { recursive: true });

  return {
    prompt,
    prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
    prompt_path_abs: join(spec.keep_dir_abs, 'PROMPT.md'),
    pack,
  };
}

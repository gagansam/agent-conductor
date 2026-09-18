import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import type { InstructionDoc } from '../contracts/pack.js';
import { RoleSchema, type Role } from '../contracts/task.js';
import { git } from '../git/exec.js';
import { splitFrontmatter } from '../task/parse.js';

const ALL_ROLES: Role[] = ['implementer', 'reviewer', 'reproducer'];
const isGlob = (s: string): boolean => /[*?[\]{}]/.test(s);

export interface InstructionWarning {
  source: string;
  code: 'missing' | 'vendor_token' | 'bad_frontmatter';
  message: string;
}

export interface LoadedInstructions {
  docs: InstructionDoc[];
  warnings: InstructionWarning[];
}

/** Tokens that mean something to one vendor and nothing to the other. They belong outside the shared body. */
const VENDOR_TOKENS: { re: RegExp; what: string }[] = [
  { re: /\$ARGUMENTS\b/, what: 'Claude Code slash-command placeholder $ARGUMENTS' },
  { re: /^\s*allowed-tools\s*:/m, what: 'Claude Code `allowed-tools` frontmatter' },
  { re: /^@[\w./-]+\s*$/m, what: 'Claude Code @-import (Codex does not expand it)' },
  { re: /\bBash\([^)]*\)/, what: 'Claude Code tool-permission syntax Bash(...)' },
];

/**
 * Read the repo's instruction sources from `root` (a worktree at base_sha, so
 * the pack matches the code under work) and inline them as plain markdown.
 * One copy, read by the conductor, given identically to every vendor.
 */
export async function loadInstructions(root: string, sources: string[]): Promise<LoadedInstructions> {
  const docs: InstructionDoc[] = [];
  const warnings: InstructionWarning[] = [];
  const seen = new Set<string>();
  let tracked: string[] | undefined;

  for (const pattern of sources) {
    let matches: string[];
    if (isGlob(pattern)) {
      tracked ??= (await git(root, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean);
      const match = picomatch(pattern, { dot: true });
      // Not `.filter(match)`: the matcher's second parameter would receive the index.
      matches = tracked.filter((f) => match(f)).sort();
    } else {
      matches = existsSync(join(root, pattern)) ? [pattern] : [];
    }
    if (!matches.length) {
      warnings.push({ source: pattern, code: 'missing', message: `instruction source "${pattern}" matched no files` });
      continue;
    }
    for (const rel of matches) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      const raw = readFileSync(join(root, rel), 'utf8');
      const { frontmatter, body } = splitFrontmatter(raw);
      let meta: Record<string, unknown> = {};
      if (frontmatter !== null) {
        try {
          meta = (parseYaml(frontmatter) as Record<string, unknown> | null) ?? {};
        } catch (e) {
          warnings.push({ source: rel, code: 'bad_frontmatter', message: `frontmatter is not valid YAML: ${(e as Error).message}` });
        }
      }
      for (const t of VENDOR_TOKENS) {
        if (t.re.test(raw)) warnings.push({ source: rel, code: 'vendor_token', message: `contains ${t.what}` });
      }
      const roles = (meta.conductor as { roles?: unknown } | undefined)?.roles;
      const applies = Array.isArray(roles) ? roles.filter((r): r is Role => RoleSchema.safeParse(r).success) : [];
      const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
      const name = typeof meta.name === 'string' ? meta.name : typeof meta.title === 'string' ? meta.title : undefined;
      docs.push({ source: rel, title: name ?? heading ?? rel, body: body.trim(), applies_to: applies.length ? applies : ALL_ROLES });
    }
  }
  return { docs, warnings };
}

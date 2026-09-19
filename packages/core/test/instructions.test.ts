import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectRepo } from '../src/config/detect.js';
import { isExternalSource, loadInstructions } from '../src/instructions/load.js';
import { makeTempRepo, type TempRepo } from './helpers/repo.js';

let repo: TempRepo;
let made = false;
afterEach(() => {
  if (made) repo.dispose();
  made = false;
});

/** A workspace folder holding the repo, with shared instructions one level up, like field-scope/repo. */
function workspace(): string {
  repo = makeTempRepo({ 'README.md': '# app\n', 'AGENTS.md': '# Repo rules\n' });
  made = true;
  const ws = dirname(repo.root);
  const write = (rel: string, body: string): void => {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), body);
  };
  write('AGENTS.md', '# Workspace\n\nShared rules for every repo.\n');
  write('.claude/skills/expert-review/SKILL.md', '---\nname: expert-review\nconductor:\n  roles: [reviewer]\n---\n# Review\n\nBe thorough.\n');
  write('.claude/skills/verify-change/SKILL.md', '---\nname: verify-change\n---\n# Verify\n\nRun the checks.\n');
  return ws;
}

describe('instruction sources outside the repo', () => {
  it('recognises external paths', () => {
    expect(['../AGENTS.md', '/abs/x.md', '..'].every(isExternalSource)).toBe(true);
    expect(['AGENTS.md', 'docs/../x.md', '.claude/skills/a/SKILL.md'].some(isExternalSource)).toBe(false);
  });

  it('reads ../ files and globs relative to the repo, even when loading from a worktree elsewhere', async () => {
    workspace();
    const elsewhere = join(repo.scratch, 'worktree-stand-in');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'AGENTS.md'), '# Repo rules\n');
    const r = await loadInstructions(elsewhere, ['AGENTS.md', '../AGENTS.md', '../.claude/skills/*/SKILL.md'], { repo_abs: repo.root });
    expect(r.docs.map((d) => [d.source, d.title])).toEqual([
      ['AGENTS.md', 'Repo rules'],
      ['../AGENTS.md', 'Workspace'],
      ['../.claude/skills/expert-review/SKILL.md', 'expert-review'],
      ['../.claude/skills/verify-change/SKILL.md', 'verify-change'],
    ]);
    expect(r.docs[2]!.applies_to).toEqual(['reviewer']);
    expect(r.warnings).toEqual([]);
  });

  it('warns about an external source that does not exist', async () => {
    workspace();
    const r = await loadInstructions(repo.root, ['../MISSING.md'], { repo_abs: repo.root });
    expect(r.warnings.map((w) => w.code)).toEqual(['missing']);
  });

  it('init detection offers the workspace AGENTS.md and skills', async () => {
    workspace();
    const d = await detectRepo(repo.root);
    expect(d.instruction_sources).toEqual(['AGENTS.md']);
    expect(d.instruction_candidates).toEqual(['../AGENTS.md', '../.claude/skills/expert-review/SKILL.md', '../.claude/skills/verify-change/SKILL.md']);
  });

  it('enables the workspace AGENTS.md when the repo has none of its own', async () => {
    workspace();
    repo.run(['rm', '-q', 'AGENTS.md']);
    repo.run(['commit', '-q', '-m', 'no repo instructions']);
    const d = await detectRepo(repo.root);
    expect(d.instruction_sources).toEqual(['../AGENTS.md']);
    expect(d.warnings.some((w) => w.includes('no committed AGENTS.md'))).toBe(false);
  });
});

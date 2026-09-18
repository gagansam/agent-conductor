import { describe, expect, it } from 'vitest';
import { GlobalConfigSchema } from '../src/config/schema.js';
import { parseModelJson, roleOutput, stripNulls } from '../src/contracts/json-schema.js';
import { VerdictOutputSchema } from '../src/contracts/verdict.js';
import { ImplementerReportSchema } from '../src/contracts/work-product.js';
import { ulid } from '../src/ids.js';
import { parseTask, splitFrontmatter, TaskError } from '../src/task/parse.js';

const global = GlobalConfigSchema.parse({
  version: 1,
  providers: { claude: { adapter: 'x', models: { strong: 'opus' } } },
  roles: { implementer: { provider: 'claude', model: 'strong' } },
});

// The example task from docs/03-contracts.md §8.
const TASK_MD = `---
title: Add "archive" action to project list
kind: feature
acceptance:
  - id: AC1
    text: A project row shows an Archive action that moves it to the Archived tab
    check: { kind: test, run: "pnpm vitest run src/projects/archive.test.tsx", expect: pass }
  - id: AC2
    text: Archived projects are excluded from the default list query
    check: { kind: test, run: "pnpm vitest run src/projects/list.test.ts", expect: pass }
  - id: AC3
    text: The action is keyboard reachable
    check: { kind: manual }
constraints:
  - No new dependencies
touch_hint: ["src/projects/**", "src/api/projects.ts"]
context_files: ["docs/invariants/projects.md"]
budget: { max_rounds: 2 }
gates: [before_apply]
---

Users need to archive projects without deleting them.
`;

// The example verdict from docs/03-contracts.md §9.
const VERDICT = {
  schema_version: 1,
  decision: 'request_changes',
  summary: 'The list query does not exclude archived projects when a text filter is active.',
  findings: [
    {
      id: 'F1',
      severity: 'major',
      category: 'spec-mismatch',
      file: 'src/api/projects.ts',
      line: 88,
      claim: 'listProjects() returns archived projects when `q` is non-empty.',
      evidence: 'Lines 84-95',
      reproduction: {
        kind: 'test',
        files: ['src/projects/__repro__/archive-filter.test.ts'],
        run: 'pnpm vitest run src/projects/__repro__/archive-filter.test.ts',
        expect: 'fail',
      },
    },
  ],
  advice: [{ id: 'A1', category: 'structure', file: 'src/projects/ArchiveButton.tsx', text: 'Share the confirm dialog.' }],
  coverage: { files_reviewed: ['src/api/projects.ts'], files_skipped: [] },
  acceptance_assessment: [{ id: 'AC2', met: 'no', note: 'see F1' }],
  confidence: 0.8,
};

describe('task parsing', () => {
  it('parses the documented example and applies config defaults', () => {
    const t = parseTask(TASK_MD, { repo_abs: '/tmp/repo', global, id: 'T1' });
    expect(t.id).toBe('T1');
    expect(t.kind).toBe('feature');
    expect(t.acceptance.map((a) => a.id)).toEqual(['AC1', 'AC2', 'AC3']);
    expect(t.acceptance[2]?.check).toEqual({ kind: 'manual' });
    expect(t.budget.max_rounds).toBe(2);
    expect(t.budget.max_worker_runs).toBe(global.loop.max_worker_runs);
    expect(t.gates).toEqual(['before_apply']);
    expect(t.description).toBe('Users need to archive projects without deleting them.');
  });

  it('falls back to the configured default gates', () => {
    const t = parseTask(TASK_MD.replace('gates: [before_apply]\n', ''), { repo_abs: '/tmp/repo', global });
    expect(t.gates).toEqual(global.gates.default);
  });

  it('rejects missing frontmatter, missing acceptance, empty body and duplicate ids', () => {
    const opts = { repo_abs: '/tmp/repo', global };
    expect(() => parseTask('just text', opts)).toThrow(TaskError);
    expect(() => parseTask('---\ntitle: x\n---\nbody', opts)).toThrow(/acceptance/);
    expect(() => parseTask('---\ntitle: x\nacceptance: [{id: A, text: t}]\n---\n', opts)).toThrow(/description/);
    expect(() => parseTask('---\ntitle: x\nacceptance: [{id: A, text: t}, {id: A, text: u}]\n---\nbody', opts)).toThrow(/duplicate/);
  });

  it('splits frontmatter with CRLF and BOM', () => {
    expect(splitFrontmatter('﻿---\r\na: 1\r\n---\r\nbody')).toEqual({ frontmatter: 'a: 1', body: 'body' });
  });
});

describe('model output', () => {
  it('accepts the documented verdict and fills defaults', () => {
    const r = parseModelJson(VerdictOutputSchema, JSON.stringify(VERDICT));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.findings[0]?.reproduction.kind).toBe('test');
  });

  it('tolerates code fences and nulls', () => {
    const withNulls = { ...VERDICT, findings: [{ ...VERDICT.findings[0], end_line: null, suggested_fix: null }] };
    const r = parseModelJson(VerdictOutputSchema, 'Here you go:\n```json\n' + JSON.stringify(withNulls) + '\n```\n');
    expect(r.ok).toBe(true);
    expect(stripNulls({ a: null, b: [{ c: null, d: 1 }] })).toEqual({ b: [{ d: 1 }] });
  });

  it('reports field paths for invalid documents', () => {
    const bad = { ...VERDICT, findings: [{ ...VERDICT.findings[0], severity: 'catastrophic', reproduction: { kind: 'test', files: [], run: '' } }] };
    const r = parseModelJson(VerdictOutputSchema, JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.startsWith('findings.0.severity'))).toBe(true);
      expect(r.errors.some((e) => e.startsWith('findings.0.reproduction.files'))).toBe(true);
    }
  });

  it('reports non-JSON', () => {
    const r = parseModelJson(ImplementerReportSchema, 'I finished the work!');
    expect(r.ok).toBe(false);
  });

  it('exports a JSON Schema per role', () => {
    const reviewer = roleOutput('reviewer');
    expect(reviewer.path_rel).toBe('.conductor/out/verdict.json');
    const js = reviewer.json_schema as { type?: string; properties?: Record<string, unknown>; required?: string[] };
    expect(js.type).toBe('object');
    expect(Object.keys(js.properties ?? {})).toContain('findings');
    expect(js.required).toContain('decision');
    expect(js.required).not.toContain('advice');
    expect(roleOutput('implementer').path_rel).toBe('.conductor/out/report.json');
  });
});

describe('ulid', () => {
  it('is 26 chars and sorts by time', () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
  });
});

import { z } from 'zod';
import { QuestionsOutputSchema } from './clarify.js';
import type { Role } from './task.js';
import { ReproOutputSchema, VerdictOutputSchema } from './verdict.js';
import { ImplementerReportSchema } from './work-product.js';

export interface RoleOutput {
  /** Relative to the worktree root. */
  path_rel: string;
  schema: z.ZodType;
  json_schema: object;
}

export const OUT_DIR_REL = '.conductor/out';
export const PACK_DIR_REL = '.conductor/pack';

const toJson = (schema: z.ZodType): object => z.toJSONSchema(schema, { io: 'input' }) as object;

/** What a worker produces: one per role, plus the implementer's clarify turn. */
export type OutputKind = Role | 'questions';

const OUTPUTS: Record<OutputKind, { file: string; schema: z.ZodType }> = {
  implementer: { file: 'report.json', schema: ImplementerReportSchema },
  reviewer: { file: 'verdict.json', schema: VerdictOutputSchema },
  reproducer: { file: 'repro.json', schema: ReproOutputSchema },
  questions: { file: 'questions.json', schema: QuestionsOutputSchema },
};

/** The file a worker must write, and the JSON Schema it must satisfy. */
export function outputSpec(kind: OutputKind): RoleOutput {
  const o = OUTPUTS[kind];
  return { path_rel: `${OUT_DIR_REL}/${o.file}`, schema: o.schema, json_schema: toJson(o.schema) };
}

export function roleOutput(role: Role): RoleOutput {
  return outputSpec(role);
}

/** Models write `"line": null` for "unknown". The schemas say optional, so drop nulls before validating. */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = stripNulls(v);
    return out;
  }
  return value;
}

export type ParsedOutput<T> = { ok: true; value: T } | { ok: false; errors: string[]; raw: string };

/** Parse model-written JSON against a schema, tolerating code fences and nulls. */
export function parseModelJson<T>(schema: z.ZodType<T>, text: string): ParsedOutput<T> {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  let lastError = 'empty output';
  for (const c of candidates) {
    if (!c) continue;
    let json: unknown;
    try {
      json = JSON.parse(c);
    } catch (e) {
      lastError = `not valid JSON: ${(e as Error).message}`;
      continue;
    }
    const r = schema.safeParse(stripNulls(json));
    if (r.success) return { ok: true, value: r.data };
    return { ok: false, raw: text, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  return { ok: false, raw: text, errors: [lastError] };
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { outputSpec, PACK_DIR_REL, parseModelJson, type OutputKind, type ParsedOutput } from '../contracts/json-schema.js';

/**
 * Read a role's output. The file is the contract; the final message is the
 * fallback, because a worker in a stricter sandbox than we asked for may be
 * unable to write and will print the document instead.
 */
export function readRoleOutput<T>(worktree_abs: string, kind: OutputKind, final_text: string): ParsedOutput<T> {
  const out = outputSpec(kind);
  const schema = out.schema as z.ZodType<T>;
  const file = join(worktree_abs, out.path_rel);
  if (existsSync(file)) return parseModelJson(schema, readFileSync(file, 'utf8'));
  const fromText = parseModelJson(schema, final_text);
  if (fromText.ok) return fromText;
  return { ok: false, raw: '', errors: [`${out.path_rel} was not written`] };
}

/** The one repair turn a worker gets when its output file is missing or invalid. */
export function repairPrompt(kind: OutputKind, errors: string[], raw: string, originalPrompt?: string): string {
  const out = outputSpec(kind);
  // The clarify turn is read-only: its document is the final message, not a file.
  const viaMessage = kind === 'questions';
  const parts = [
    `Your previous turn did not produce a valid ${viaMessage ? 'JSON document' : `\`${out.path_rel}\``}. Nothing else about your work is being questioned.`,
    '',
    'Problems found:',
    ...errors.slice(0, 20).map((e) => `- ${e}`),
    '',
    viaMessage
      ? `Reply now with only the corrected JSON document, conforming to \`${PACK_DIR_REL}/OUTPUT-SCHEMA.json\` and including \`"schema_version": 1\`. No other text.`
      : `Write a corrected \`${out.path_rel}\` now. It must be a single JSON document that conforms to \`${PACK_DIR_REL}/OUTPUT-SCHEMA.json\`, including \`"schema_version": 1\`. Use your file-writing tool. Do not change any other file.`,
  ];
  if (raw.trim()) parts.push('', 'What you wrote before:', '', '```', raw.slice(0, 8000), '```');
  if (originalPrompt) parts.push('', '---', '', 'For reference, these were your original instructions:', '', originalPrompt);
  return parts.join('\n');
}

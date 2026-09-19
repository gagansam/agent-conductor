import { z } from 'zod';
import { OwnChoiceSchema, QuestionSchema } from './clarify.js';

export const ClaimSchema = z.object({
  text: z.string(),
  command: z.string().optional(),
  observed: z.string().optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

/** Written by the implementer to .conductor/out/report.json. Claims are recorded, never trusted. */
export const ImplementerReportSchema = z.object({
  schema_version: z.literal(1),
  summary: z.string(),
  approach: z.string().default(''),
  acceptance: z
    .array(
      z.object({
        id: z.string(),
        status: z.enum(['done', 'partial', 'not_done', 'not_applicable']),
        note: z.string().optional(),
      }),
    )
    .default([]),
  claims: z.array(ClaimSchema).default([]),
  /** Follow-ups for the operator that did not affect this change. */
  open_questions: z.array(z.string()).default([]),
  /** Set only when the implementer stopped mid-work: a wrong guess here would force redoing most of the work. */
  blocking_questions: z.array(QuestionSchema).default([]),
  /** Judgment calls it made itself because they are cheap to change; reviewed by the operator before code review. */
  decisions_made: z.array(OwnChoiceSchema).default([]),
  risks: z.array(z.string()).default([]),
  did_not_do: z.array(z.string()).default([]),
});
export type ImplementerReport = z.infer<typeof ImplementerReportSchema>;

/** Computed by the conductor from the worktree. Nothing here comes from a model. */
export interface PatchInfo {
  path_abs: string;
  sha256: string;
  files_changed: string[];
  insertions: number;
  deletions: number;
  binary_files: string[];
  outside_touch_hint: string[];
  untracked_added: string[];
  /** Deleting a test is the classic way to make a red check green; the operator should always see these. */
  deleted: string[];
  empty: boolean;
}

export interface WorkProduct {
  schema_version: 1;
  run_id: string;
  round: number;
  worker_run_id: string;
  patch: PatchInfo;
  report: ImplementerReport | null;
  report_valid: boolean;
}

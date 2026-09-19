import { z } from 'zod';
import { AcceptanceCriterionSchema, TaskKindSchema } from './task.js';

/** What the draft turn proposes for `conductor task`. The operator reviews every field before anything is saved. */
export const TaskDraftSchema = z.object({
  schema_version: z.literal(1),
  title: z.string().min(1),
  kind: TaskKindSchema.default('feature'),
  /** The operator's request made precise, in their terms. */
  description: z.string().min(1),
  acceptance: z.array(AcceptanceCriterionSchema).min(1),
  touch_hint: z.array(z.string()).default([]),
  context_files: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  /** Ambiguities it noticed; the run asks about these again before coding. */
  notes: z.string().default(''),
});
export type TaskDraft = z.infer<typeof TaskDraftSchema>;

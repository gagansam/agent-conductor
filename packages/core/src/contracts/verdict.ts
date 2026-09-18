import { z } from 'zod';

export const SeveritySchema = z.enum(['blocker', 'major', 'minor']);
export type Severity = z.infer<typeof SeveritySchema>;

export const CategorySchema = z.enum([
  'correctness',
  'regression',
  'spec-mismatch',
  'security',
  'data-loss',
  'concurrency',
  'perf',
  'test-gap',
  'error-handling',
  'api-contract',
]);
export type Category = z.infer<typeof CategorySchema>;

export const ReproductionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('test'),
    /** Paths the reviewer created in ITS worktree, under repro_allowed_paths. */
    files: z.array(z.string().min(1)).min(1),
    /** Command that executes exactly those tests. */
    run: z.string().min(1),
    /** Must fail on the implementer's tree to confirm. */
    expect: z.literal('fail').default('fail'),
  }),
  z.object({
    kind: z.literal('command'),
    run: z.string().min(1),
    /** Default: any nonzero exit confirms. */
    expect_exit: z.number().int().optional(),
    expect_stdout_regex: z.string().optional(),
  }),
  z.object({ kind: z.literal('acceptance'), criterion_id: z.string().min(1) }),
  z.object({ kind: z.literal('none'), why: z.string() }),
]);
export type Reproduction = z.infer<typeof ReproductionSchema>;

export const ConfirmationSchema = z.object({
  status: z.enum(['confirmed', 'refuted', 'unappliable', 'needs_human', 'error']),
  ran: z.string(),
  exit_code: z.number().int().nullable().optional(),
  log_path_abs: z.string().optional(),
  harvested_files: z.array(z.string()).optional(),
  note: z.string(),
});
export type Confirmation = z.infer<typeof ConfirmationSchema>;

/** A finding as the model writes it. */
export const FindingOutputSchema = z.object({
  id: z.string().min(1),
  severity: SeveritySchema,
  category: CategorySchema,
  file: z.string(),
  line: z.number().int().optional(),
  end_line: z.number().int().optional(),
  /** ONE falsifiable sentence. */
  claim: z.string().min(1),
  evidence: z.string().default(''),
  reproduction: ReproductionSchema,
  suggested_fix: z.string().optional(),
  regression_of: z.string().optional(),
});
export type FindingOutput = z.infer<typeof FindingOutputSchema>;

/** A finding after the conductor has tried to confirm it. */
export interface Finding extends FindingOutput {
  /** Conductor-assigned ULID. `id` keeps the model's label ("F1"). */
  uid: string;
  confirmation: Confirmation;
  /** True when demoted: it is reported, never acted on. */
  is_advice: boolean;
}

export const AdviceSchema = z.object({
  id: z.string(),
  category: z.union([CategorySchema, z.enum(['style', 'naming', 'structure', 'docs'])]),
  file: z.string().optional(),
  line: z.number().int().optional(),
  text: z.string(),
});
export type Advice = z.infer<typeof AdviceSchema>;

/** Written by the reviewer to .conductor/out/verdict.json. */
export const VerdictOutputSchema = z.object({
  schema_version: z.literal(1),
  /** The model's opinion. Recorded; it does not gate anything. */
  decision: z.enum(['approve', 'request_changes', 'reject']),
  summary: z.string(),
  findings: z.array(FindingOutputSchema).default([]),
  advice: z.array(AdviceSchema).default([]),
  coverage: z
    .object({
      files_reviewed: z.array(z.string()).default([]),
      files_skipped: z.array(z.string()).default([]),
      skipped_reason: z.string().optional(),
    })
    .default({ files_reviewed: [], files_skipped: [] }),
  acceptance_assessment: z
    .array(z.object({ id: z.string(), met: z.enum(['yes', 'no', 'unclear']), note: z.string().optional() }))
    .default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});
export type VerdictOutput = z.infer<typeof VerdictOutputSchema>;

export interface ReviewerIdentity {
  provider: string;
  model_label: string;
  model_id: string;
  worker_run_id: string;
  same_vendor: boolean;
}

export interface Verdict extends Omit<VerdictOutput, 'findings'> {
  run_id: string;
  round: number;
  reviewer: ReviewerIdentity;
  findings: Finding[];
}

/** Written by a reproducer to .conductor/out/repro.json. */
export const ReproOutputSchema = z.object({
  schema_version: z.literal(1),
  reproductions: z.array(ReproductionSchema).default([]),
  notes: z.string().default(''),
});
export type ReproOutput = z.infer<typeof ReproOutputSchema>;

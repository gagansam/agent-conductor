import { z } from 'zod';

export const RoleSchema = z.enum(['implementer', 'reviewer', 'reproducer']);
export type Role = z.infer<typeof RoleSchema>;

export const TaskKindSchema = z.enum(['feature', 'bugfix', 'refactor', 'chore']);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const GateSchema = z.enum(['after_reproduce', 'after_implement', 'after_review', 'before_apply']);
export type Gate = z.infer<typeof GateSchema>;

export const CheckSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), run: z.string().min(1), expect_exit: z.number().int().default(0) }),
  z.object({ kind: z.literal('test'), run: z.string().min(1), expect: z.literal('pass').default('pass') }),
  z.object({ kind: z.literal('manual') }),
]);
export type Check = z.infer<typeof CheckSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  check: CheckSchema.optional(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const VerificationStepSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['test', 'lint', 'typecheck', 'build', 'browser', 'custom']),
  run: z.string().min(1),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().positive().default(600_000),
  required: z.boolean().default(true),
  parse: z.enum(['junit', 'eslint-json', 'tsc', 'pytest', 'none']).default('none'),
  /** Where the step writes its machine-readable report (junit xml, eslint json), relative to the worktree. */
  report_path: z.string().optional(),
  artifacts: z.array(z.string()).default([]),
});
export type VerificationStep = z.infer<typeof VerificationStepSchema>;

export const BudgetSchema = z.object({
  max_rounds: z.number().int().positive(),
  max_fix_attempts_per_round: z.number().int().nonnegative(),
  max_worker_runs: z.number().int().positive(),
  max_wall_ms: z.number().int().positive(),
  max_reviewers: z.number().int().nonnegative(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const RoleTargetSchema = z.object({
  provider: z.string().min(1),
  /** A label in providers[p].models, never a vendor id. */
  model: z.string().min(1),
  effort: z.string().optional(),
  optional: z.boolean().default(false),
  fallback: z.array(z.object({ provider: z.string(), model: z.string() })).default([]),
});
export type RoleTarget = z.infer<typeof RoleTargetSchema>;

export const VerificationOverrideSchema = z.object({
  add: z.array(VerificationStepSchema).default([]),
  disable: z.array(z.string()).default([]),
});
export type VerificationOverride = z.infer<typeof VerificationOverrideSchema>;

/** What the operator writes in task.md frontmatter. Everything but title and acceptance is optional. */
export const TaskFileSchema = z.object({
  title: z.string().min(1),
  kind: TaskKindSchema.default('feature'),
  base_ref: z.string().optional(),
  acceptance: z.array(AcceptanceCriterionSchema).min(1, 'a task needs at least one acceptance criterion'),
  constraints: z.array(z.string()).default([]),
  touch_hint: z.array(z.string()).default([]),
  context_files: z.array(z.string()).default([]),
  verification: VerificationOverrideSchema.default({ add: [], disable: [] }),
  budget: BudgetSchema.partial().default({}),
  routing: z.record(z.string(), RoleTargetSchema).default({}),
  gates: z.array(GateSchema).optional(),
  reference: z.array(z.string()).default([]),
});
export type TaskFile = z.infer<typeof TaskFileSchema>;

/** The frozen, fully-resolved task. */
export const TaskSpecSchema = z.object({
  schema_version: z.literal(1),
  id: z.string(),
  title: z.string(),
  kind: TaskKindSchema,
  repo: z.object({ path_abs: z.string(), base_ref: z.string().optional() }),
  description: z.string(),
  acceptance: z.array(AcceptanceCriterionSchema).min(1),
  constraints: z.array(z.string()),
  touch_hint: z.array(z.string()),
  context_files: z.array(z.string()),
  verification: VerificationOverrideSchema,
  budget: BudgetSchema,
  routing: z.record(z.string(), RoleTargetSchema),
  gates: z.array(GateSchema),
  reference: z.array(z.string()),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

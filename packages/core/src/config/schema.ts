import { z } from 'zod';
import { GateSchema, RoleTargetSchema, VerificationStepSchema } from '../contracts/task.js';

export const ProviderConfigSchema = z.object({
  /** Package name (or path) of the adapter. Resolved by the host, never by the core. */
  adapter: z.string().min(1),
  binary: z.string().optional(),
  /** A quota decision, not a process-count decision. */
  max_concurrent: z.number().int().positive().default(1),
  /** Do not dispatch above this five-hour utilization, when the provider reports one. */
  reserve_utilization: z.number().min(0).max(1).default(0.85),
  /** label → opaque vendor model id. The only place vendor ids live. */
  models: z.record(z.string(), z.string()).default({}),
  /** Passed verbatim to the adapter factory. */
  options: z.record(z.string(), z.unknown()).default({}),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const LoopConfigSchema = z.object({
  max_rounds: z.number().int().positive().default(3),
  max_fix_attempts_per_round: z.number().int().nonnegative().default(2),
  max_worker_runs: z.number().int().positive().default(8),
  max_wall_ms: z.number().int().positive().default(45 * 60_000),
  max_reviewers: z.number().int().nonnegative().default(1),
  idle_timeout_ms: z.number().int().positive().default(10 * 60_000),
  worker_total_timeout_ms: z.number().int().positive().default(30 * 60_000),
  max_quota_wait_ms: z.number().int().nonnegative().default(15 * 60_000),
  require_cross_vendor_review: z.enum(['enforce', 'warn', 'off']).default('warn'),
  /** Run the repo's checks on the untouched base commit before spending any worker quota. */
  verify_baseline: z.boolean().default(true),
});
export type LoopConfig = z.infer<typeof LoopConfigSchema>;

export const GlobalConfigSchema = z.object({
  version: z.literal(1),
  providers: z.record(z.string(), ProviderConfigSchema),
  /** Keys: implementer, reviewer, reviewer_2 …, reproducer. */
  roles: z.record(z.string(), RoleTargetSchema),
  loop: LoopConfigSchema.default(() => LoopConfigSchema.parse({})),
  gates: z.object({ default: z.array(GateSchema).default(['after_review', 'before_apply']) }).default({ default: ['after_review', 'before_apply'] }),
  notify: z
    .object({ macos_notification: z.boolean().default(false), bell: z.boolean().default(true), hook: z.string().default('') })
    .default({ macos_notification: false, bell: true, hook: '' }),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export const SetupConfigSchema = z.object({
  run: z.string().optional(),
  rerun_if: z.array(z.string()).default([]),
  /** Dependency directories cloned copy-on-write from the primary checkout before `run`. */
  clone_dirs: z.array(z.string()).default([]),
  /** Gitignored files that workers and verification need. Logged; never in the pack. */
  copy_untracked: z.array(z.string()).default([]),
  timeout_ms: z.number().int().positive().default(300_000),
});
export type SetupConfig = z.infer<typeof SetupConfigSchema>;

export const RepoConfigSchema = z.object({
  version: z.literal(1),
  setup: SetupConfigSchema.default(() => SetupConfigSchema.parse({})),
  verification: z.array(VerificationStepSchema).default([]),
  repro: z
    .object({ allowed_paths: z.array(z.string()).default(['tests/**', '**/__repro__/**']), max_files: z.number().int().positive().default(5) })
    .default({ allowed_paths: ['tests/**', '**/__repro__/**'], max_files: 5 }),
  instructions: z.object({ sources: z.array(z.string()).default(['AGENTS.md']) }).default({ sources: ['AGENTS.md'] }),
  policy: z
    .object({
      network: z.boolean().default(false),
      allowed_commands: z.array(z.string()).default([]),
      denied_commands: z.array(z.string()).default([]),
    })
    .default({ network: false, allowed_commands: [], denied_commands: [] }),
  routing: z.record(z.string(), RoleTargetSchema).default({}),
  templates: z.string().optional(),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

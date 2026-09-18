import type { FixTarget } from './round.js';
import type { Role, TaskSpec } from './task.js';
import type { Finding } from './verdict.js';
import type { VerificationSummary } from './verification.js';

export interface InstructionDoc {
  /** Path relative to the repo root. */
  source: string;
  title: string;
  /** Frontmatter stripped. */
  body: string;
  applies_to: Role[];
}

export interface FileExcerpt {
  path: string;
  range?: [number, number];
  content: string;
  sha256: string;
}

export interface PriorRound {
  round: number;
  verification: VerificationSummary;
  confirmed_findings: Finding[];
  advice_count: number;
  implementer_report_summary: string;
}

export type RoleAddendum =
  | { role: 'implementer'; fix_targets: FixTarget[] }
  | { role: 'reviewer'; diff_path: 'DIFF.patch'; report_path: 'REPORT.json'; repro_allowed_paths: string[] }
  | { role: 'reproducer'; repro_allowed_paths: string[] };

/** The part of the pack that is byte-identical for every worker in a round. pack_id hashes this. */
export interface PackBase {
  schema_version: 1;
  task: TaskSpec;
  repo: { base_sha: string; branch: string; root_rel: '.'; verification_summary: string };
  instructions: InstructionDoc[];
  files: FileExcerpt[];
  prior: PriorRound[];
  decisions: string[];
}

export interface ContextPack extends PackBase {
  pack_id: string;
  run_id: string;
  round: number;
  addendum: RoleAddendum;
}

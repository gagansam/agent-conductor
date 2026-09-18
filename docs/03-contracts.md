# 03 — Contracts

The schemas below are the system. They are written as TypeScript types
because that is what the implementation will use (zod definitions in
`core/contracts/`, with JSON Schema generated from them for the files workers
must write). Field names and types are final unless an open question says
otherwise. Prose after each schema explains the non-obvious fields.

Conventions:

- Ids are ULIDs. Times are ISO-8601 strings in UTC. Durations are `_ms`.
- Paths inside a contract are relative to the worktree root unless suffixed
  `_abs`.
- Anything a model writes is validated against the JSON Schema before the
  core reads it. Anything the conductor computes (diff stats, hashes, exit
  codes) is never taken from a model.
- Every model-written document has `schema_version: 1`.

---

## 1. TaskSpec — what the operator hands in

Authored as `task.md`: YAML frontmatter matching the type, markdown body
becomes `description`. `conductor new` scaffolds one; `conductor run --task
"..."` builds one with repo defaults for quick tasks.

```ts
type TaskKind = 'feature' | 'bugfix' | 'refactor' | 'chore';

interface TaskSpec {
  schema_version: 1;
  id: string;                          // assigned by conductor
  title: string;                       // one line
  kind: TaskKind;                      // selects the workflow template
  repo: {
    path_abs: string;                  // primary checkout; v1: exactly one repo
    base_ref?: string;                 // default: HEAD of the primary checkout
  };
  description: string;                 // markdown; the actual ask
  acceptance: AcceptanceCriterion[];   // at least one
  constraints: string[];               // "no new dependencies", "do not touch src/legacy/**"
  touch_hint: string[];                // globs the operator expects to change; advisory
  context_files: string[];             // globs of files to inline into the pack; optional
  verification: VerificationOverride;  // merged onto repo defaults
  budget: Budget;
  routing: Partial<Record<Role, RoleTarget>>;   // per-task override of config roles
  gates: Gate[];                       // where the run pauses for the operator
  reference: string[];                 // free-text pointers (ticket URLs, design docs); not fetched
}

interface AcceptanceCriterion {
  id: string;                          // "AC1"; stable across rounds
  text: string;                        // human sentence
  check?: Check;                       // if present, the conductor can evaluate it
}

type Check =
  | { kind: 'command'; run: string; expect_exit: number }          // default expect_exit 0
  | { kind: 'test'; run: string; expect: 'pass' }                   // a test invocation
  | { kind: 'manual' };                                             // only the operator can judge

interface VerificationOverride {
  add: VerificationStep[];             // appended to repo steps
  disable: string[];                   // repo step ids to skip for this task (must give reason in description)
}

interface VerificationStep {
  id: string;                          // "typecheck", "unit", "e2e"
  kind: 'test' | 'lint' | 'typecheck' | 'build' | 'browser' | 'custom';
  run: string;                         // shell command, run with cwd = worktree root
  cwd?: string;                        // relative to worktree root
  timeout_ms: number;
  required: boolean;                   // required + failed ⇒ verification fails
  parse?: 'junit' | 'eslint-json' | 'tsc' | 'pytest' | 'none';   // structured failure extraction
  report_path?: string;                // where the step writes its machine-readable report; else stdout is parsed
  artifacts?: string[];                // paths (relative) to copy into the run dir after the step
}

interface Budget {
  max_rounds: number;                  // default 3
  max_fix_attempts_per_round: number;  // default 2; implementer retries while verification is red
  max_worker_runs: number;             // default 8; hard cap on CLI invocations
  max_wall_ms: number;                 // default 45 min
  max_reviewers: number;               // default 1; the scheduler may lower this under quota pressure
}

type Role = 'implementer' | 'reviewer' | 'reproducer';

interface RoleTarget {
  provider: string;                    // key in config.providers
  model: string;                       // *label* in providers[p].models, resolved to an opaque vendor id
  effort?: string;                     // opaque; dropped if the adapter lacks the capability
  optional?: boolean;                  // dropped first under quota pressure
  fallback?: { provider: string; model: string }[];
}

type Gate = 'after_reproduce' | 'after_implement' | 'after_review' | 'before_apply';
```

Notes:

- `acceptance[].check` is the bridge between the operator's intent and the
  verifier. A criterion without a check can still be cited by a reviewer as a
  `spec-mismatch` finding, but that finding can only reach `needs_human`.
- `routing` refers to model *labels* (`strong`, `fast`), never vendor ids.
  Vendor ids live in one place, `config.providers[p].models`, and are edited
  by the operator when vendors rename things.
- `gates` default comes from config; `before_apply` is always on because
  `apply` is a separate command anyway.

---

## 2. ContextPack — what every worker receives

Built once per round. The **base** is identical for every worker in that
round; each role gets an **addendum**. `pack_id` hashes only the base, so the
corpus can compare two models that received byte-identical base context in
the same role.

```ts
interface ContextPack {
  schema_version: 1;
  pack_id: string;                     // sha256 of the canonical base rendering
  run_id: string;
  round: number;
  task: TaskSpec;
  repo: {
    base_sha: string;
    branch: string;                    // of the primary checkout at run start
    root_rel: '.';                     // worktree root; workers are told to treat it as the repo
    verification_summary: string;      // human-readable list of the steps the conductor will run
  };
  instructions: InstructionDoc[];      // inlined sources; see 08-instruction-portability.md
  files: FileExcerpt[];                // from task.context_files; whole files or ranges
  prior: PriorRound[];                 // empty in round 1
  decisions: string[];                 // operator notes carried across rounds (from gates)
  addendum: RoleAddendum;              // NOT part of pack_id
}

interface InstructionDoc {
  source: string;                      // path relative to repo, e.g. ".claude/skills/verify-change/SKILL.md"
  title: string;
  body: string;                        // frontmatter stripped
  applies_to: Role[];                  // from frontmatter `conductor.roles`, default all
}

interface FileExcerpt {
  path: string;
  range?: [number, number];            // 1-based inclusive line range; absent = whole file
  content: string;
  sha256: string;
}

interface PriorRound {
  round: number;
  verification: VerificationSummary;   // parsed failures only, not raw logs
  confirmed_findings: Finding[];       // with confirmation attached
  advice_count: number;                // advice is not fed back into the loop
  implementer_report_summary: string;
}

type RoleAddendum =
  | { role: 'implementer'; fix_targets: FixTarget[] }              // empty in round 1
  | { role: 'reviewer'; diff_path: 'DIFF.patch'; report_path: 'REPORT.json'; repro_allowed_paths: string[] }
  | { role: 'reproducer'; repro_allowed_paths: string[] };

interface FixTarget {
  kind: 'verification_failure' | 'confirmed_finding';
  ref: string;                         // step id or finding id
  summary: string;                     // one line
  detail: string;                      // parsed failure or finding claim + evidence
  reproduction?: Reproduction;         // how the conductor will re-check it
}
```

Materialization on disk, in `<worktree>/.conductor/pack/`:

```
PROMPT.md            role prompt from the template; references the files below by relative path
TASK.md              task rendered for humans and models
INSTRUCTIONS.md      concatenated InstructionDoc bodies with a provenance header per doc
CONTEXT.md           repo facts, verification summary, file excerpts
PRIOR.md             round ≥ 2 only
DIFF.patch           reviewer only
REPORT.json          reviewer only; the implementer's report
OUTPUT-SCHEMA.json   the JSON Schema the worker's output file must satisfy
pack.json            the ContextPack itself
```

The prompt handed to the CLI is the full text of `PROMPT.md`. The files exist
so the worker can re-read them with its own tools.

---

## 3. WorkProduct — what an implementer produces

Two halves. The patch is **computed by the conductor** from the worktree.
The report is **written by the model** to `.conductor/out/report.json`.

```ts
interface WorkProduct {
  schema_version: 1;
  run_id: string;
  round: number;
  worker_run_id: string;
  patch: PatchInfo;                    // conductor-computed
  report: ImplementerReport;           // model-written, schema-validated
  report_valid: boolean;               // false ⇒ one repair turn was attempted; see 06
}

interface PatchInfo {
  path_abs: string;                    // result of `git diff <base_sha>` with .conductor/ excluded
  sha256: string;
  files_changed: string[];
  insertions: number;
  deletions: number;
  binary_files: string[];
  outside_touch_hint: string[];        // files changed that match no touch_hint glob (advisory)
  untracked_added: string[];           // new files; included in the patch
  deleted: string[];                   // always shown to the operator: deleting a test turns a check green
  empty: boolean;
}

interface ImplementerReport {
  schema_version: 1;
  summary: string;                     // ≤ 3 sentences
  approach: string;                    // markdown; why this shape
  acceptance: { id: string; status: 'done' | 'partial' | 'not_done' | 'not_applicable'; note?: string }[];
  claims: Claim[];                     // self-reported verification; recorded, never trusted
  open_questions: string[];            // things the operator should decide
  risks: string[];                     // what the implementer thinks a reviewer should look at
  did_not_do: string[];                // explicit scope it left out and why
}

interface Claim {
  text: string;                        // "unit tests pass"
  command?: string;                    // what it ran, if anything
  observed?: string;                   // what it saw
}
```

`claims` exist for the corpus: the gap between what an implementer claims and
what verification shows is itself a per-model signal.

---

## 4. Verdict — what a reviewer produces

Written by the model to `.conductor/out/verdict.json`. The conductor then
runs every reproduction and attaches a `Confirmation` to each finding. Only
confirmed findings enter the loop ([ADR-0007](adr/0007-executable-findings.md)).

```ts
interface Verdict {
  schema_version: 1;
  run_id: string;
  round: number;
  reviewer: { provider: string; model_label: string; model_id: string; worker_run_id: string };   // conductor fills
  decision: 'approve' | 'request_changes' | 'reject';    // the model's opinion; recorded, does not gate
  summary: string;                                       // ≤ 5 sentences
  findings: Finding[];
  advice: Advice[];
  coverage: {
    files_reviewed: string[];
    files_skipped: string[];
    skipped_reason?: string;
  };
  acceptance_assessment: { id: string; met: 'yes' | 'no' | 'unclear'; note?: string }[];
  confidence: number;                                    // 0..1, model's own
}

type Severity = 'blocker' | 'major' | 'minor';
type Category =
  | 'correctness' | 'regression' | 'spec-mismatch' | 'security' | 'data-loss'
  | 'concurrency' | 'perf' | 'test-gap' | 'error-handling' | 'api-contract';

interface Finding {
  id: string;                          // "F1"; model-assigned, conductor re-keys to a ULID and keeps the label
  severity: Severity;
  category: Category;
  file: string;
  line?: number;
  end_line?: number;
  claim: string;                       // ONE falsifiable sentence: "X returns null when Y"
  evidence: string;                    // what in the diff shows it; quote lines
  reproduction: Reproduction;          // required for blocker and major; 'none' allowed only for minor
  suggested_fix?: string;              // optional; never fed to the implementer verbatim, only as a hint
  regression_of?: string;              // finding id from a prior round, if this is the same defect recurring
  // conductor-filled, after confirmation:
  uid: string;                         // ULID; `id` keeps the model's label
  confirmation: Confirmation;
  is_advice: boolean;                  // demoted: reported, never acted on
}

type Reproduction =
  | {
      kind: 'test';
      files: string[];                 // paths the reviewer created/modified in ITS worktree, under repro_allowed_paths
      run: string;                     // command that executes exactly those tests
      expect: 'fail';                  // must fail on the implementer's tree to confirm
    }
  | {
      kind: 'command';
      run: string;                     // e.g. "node -e '...'" or "curl localhost:3000/api/x"
      expect_exit?: number;            // default: nonzero exit confirms
      expect_stdout_regex?: string;    // alternative confirmation
    }
  | {
      kind: 'acceptance';
      criterion_id: string;            // confirmed iff the criterion has a check and it fails
    }
  | {
      kind: 'none';
      why: string;                     // e.g. "requires production data"; forces needs_human or advice
    };

interface Confirmation {
  status: 'confirmed' | 'refuted' | 'unappliable' | 'needs_human' | 'error';
  ran: string;                         // command actually executed, or "" for needs_human
  exit_code?: number;
  log_path_abs?: string;
  harvested_files?: string[];          // for kind 'test'
  note: string;                        // why this status
}

interface Advice {
  id: string;
  category: Category | 'style' | 'naming' | 'structure' | 'docs';
  file?: string;
  line?: number;
  text: string;                        // one paragraph max
}
```

Rules the schema encodes and the confirmer enforces:

- A `blocker` or `major` with `reproduction.kind === 'none'` is demoted to
  advice unless `category` is `security` or `data-loss`, in which case it
  becomes `needs_human`.
- A `minor` is never a loop input. Confirmed minors are reported; refuted
  minors are dropped.
- A `test` reproduction whose files fall outside `repro_allowed_paths`, or
  that modifies a file the implementer also changed, is `unappliable` and the
  finding is demoted to advice with the note preserved.
- `regression_of` is how ping-pong is detected: the second recurrence of the
  same defect escalates ([05-loop-control.md](05-loop-control.md)).

---

## 5. VerificationResult — the only ground truth

```ts
interface VerificationResult {
  schema_version: 1;
  run_id: string;
  round: number;
  attempt: number;                     // fix sub-round index within the round
  worktree_abs: string;
  base_sha: string;
  patch_sha256: string;                // what was verified
  setup: StepResult | null;            // dependency install, if it ran
  steps: StepResult[];
  passed: boolean;                     // all required steps exit 0
  duration_ms: number;
}

interface StepResult {
  step_id: string;
  kind: VerificationStep['kind'];
  command: string;
  exit_code: number | null;            // null ⇒ timed out or killed
  timed_out: boolean;
  duration_ms: number;
  stdout_path_abs: string;
  stderr_path_abs: string;
  failures: ParsedFailure[];           // empty when parse is 'none' or parsing failed
  parse_ok: boolean;
}

interface ParsedFailure {
  name: string;                        // test name, rule id, or diagnostic code
  file?: string;
  line?: number;
  message: string;                     // first 2 KB
}

interface VerificationSummary {       // what goes into the pack, not the raw result
  passed: boolean;
  failed_steps: { step_id: string; failures: ParsedFailure[]; tail: string }[];   // tail = last 40 lines of stderr
}
```

---

## 6. RoundRecord and LoopDecision — what the engine writes

```ts
interface RoundRecord {
  run_id: string;
  round: number;
  reproduce?: WorkerRunRef;            // bugfix workflow, round 1 only
  implement: WorkerRunRef[];           // 1 + fix attempts
  verification: VerificationResult[];  // one per implement attempt
  reviews: { worker_run: WorkerRunRef; verdict: Verdict | null; verdict_valid: boolean }[];
  debt: Debt;
  decision: LoopDecision;
  started_at: string;
  ended_at: string;
}

interface Debt {                       // the monotonic-progress metric
  failing_required_steps: number;
  confirmed_open_findings: number;
  total: number;                       // sum; must strictly decrease round over round
}

type LoopDecision =
  | { action: 'converged' }
  | { action: 'iterate'; fix_targets: FixTarget[] }
  | { action: 'gate'; gate: Gate; needs_human: Finding[] }
  | { action: 'escalate'; reason: EscalationReason; detail: string }
  | { action: 'abort'; reason: 'budget' | 'operator' | 'unrecoverable'; detail: string };

type EscalationReason =
  | 'no_progress'                      // debt did not decrease
  | 'regression_loop'                  // same finding recurred twice
  | 'verification_stuck'               // max_fix_attempts exhausted
  | 'invalid_output_twice'             // worker could not produce a valid file after repair
  | 'empty_diff'                       // implementer changed nothing and report says not_done
  | 'quota_exhausted'                  // all providers cooling and no fallback
  | 'scope_explosion';                 // files_changed > 3× touch_hint and > 20 files

interface WorkerRunRef { worker_run_id: string; provider: string; model_id: string; classification: string }
```

---

## 7. Worker output files — what the model must write

| Role | File | Schema |
|------|------|--------|
| implementer | `.conductor/out/report.json` | `ImplementerReport` |
| reviewer | `.conductor/out/verdict.json` | `Verdict` minus conductor-filled fields |
| reproducer | `.conductor/out/repro.json` | `{ schema_version: 1; reproductions: Reproduction[]; notes: string }` |

The prompt template tells the worker the path and that `OUTPUT-SCHEMA.json`
in the pack is authoritative. Adapters with a native structured-output flag
pass the same schema through it as well, which raises first-attempt validity
but changes nothing in the core ([ADR-0006](adr/0006-files-are-the-interface.md)).

---

## 8. Example: a task file

```markdown
---
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
  - Do not change the public API of src/api/projects.ts
touch_hint: ["src/projects/**", "src/api/projects.ts"]
context_files: ["docs/invariants/projects.md"]
budget: { max_rounds: 3 }
gates: [before_apply]
---

Users need to archive projects without deleting them. Add an Archive action to
each row in the project list; archived projects appear under a new "Archived"
tab and are hidden from the default query. Follow the pattern used for
"favorite" in `src/projects/favorite.ts`.
```

---

## 9. Example: a verdict

```json
{
  "schema_version": 1,
  "decision": "request_changes",
  "summary": "The archive mutation works but the list query does not exclude archived projects when a text filter is active.",
  "findings": [
    {
      "id": "F1",
      "severity": "major",
      "category": "spec-mismatch",
      "file": "src/api/projects.ts",
      "line": 88,
      "claim": "listProjects() returns archived projects when `q` is non-empty because the archived filter is only applied in the no-filter branch.",
      "evidence": "Lines 84-95: `where.archived = false` is set inside `if (!q)`; the `else` branch builds `where` from scratch.",
      "reproduction": {
        "kind": "test",
        "files": ["src/projects/__repro__/archive-filter.test.ts"],
        "run": "pnpm vitest run src/projects/__repro__/archive-filter.test.ts",
        "expect": "fail"
      }
    }
  ],
  "advice": [
    { "id": "A1", "category": "structure", "file": "src/projects/ArchiveButton.tsx", "text": "The confirm dialog duplicates DeleteButton's; a shared ConfirmAction would remove 40 lines." }
  ],
  "coverage": { "files_reviewed": ["src/api/projects.ts", "src/projects/ArchiveButton.tsx", "src/projects/list.ts"], "files_skipped": [] },
  "acceptance_assessment": [
    { "id": "AC1", "met": "yes" }, { "id": "AC2", "met": "no", "note": "see F1" }, { "id": "AC3", "met": "unclear" }
  ],
  "confidence": 0.8
}
```

After confirmation the conductor attaches:

```json
"confirmation": {
  "status": "confirmed",
  "ran": "pnpm vitest run src/projects/__repro__/archive-filter.test.ts",
  "exit_code": 1,
  "harvested_files": ["src/projects/__repro__/archive-filter.test.ts"],
  "note": "test failed on implementer tree as expected; added to verification plan for rounds ≥ 2"
}
```

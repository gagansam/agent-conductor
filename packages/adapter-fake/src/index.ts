/**
 * A scripted adapter. It never spawns anything: each step edits files in the
 * job's cwd, writes the role's output file, and reports a classification.
 * Core tests drive the whole loop with it; it is also the template a new
 * adapter author forks.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ADAPTER_API_VERSION,
  AsyncQueue,
  type CapabilitySet,
  type Classification,
  type Detection,
  type DetectOptions,
  type KillReason,
  type Role,
  type WorkerAdapter,
  type WorkerEvent,
  type WorkerHandle,
  type WorkerJob,
  type WorkerResult,
} from '@agent-conductor/adapter-api';

export interface FakeStep {
  /** Files to write relative to cwd. `null` deletes. */
  writes?: Record<string, string | null>;
  /** The JSON document for the job's first output file. Omit to write nothing. */
  output?: unknown;
  /** Raw text for the output file, to simulate invalid JSON. Wins over `output`. */
  output_raw?: string;
  final_text?: string;
  classification?: Classification;
  exit_code?: number | null;
  detail?: string;
  /** Extra events emitted between started and ended. */
  events?: WorkerEvent[];
  /** Arbitrary side effect, e.g. misbehaving with git to exercise the audit. */
  run?: (job: WorkerJob) => void | Promise<void>;
  /** Never finish until killed. */
  hang?: boolean;
  delay_ms?: number;
}

export type FakeScript = Partial<Record<Role, FakeStep[]>> | ((job: WorkerJob, callIndex: number) => FakeStep);

export interface FakeAdapterOptions {
  id?: string;
  script: FakeScript;
  capabilities?: Partial<CapabilitySet>;
  detection?: Partial<Detection>;
}

export interface FakeAdapter extends WorkerAdapter {
  /** Every job received, in order. */
  readonly jobs: WorkerJob[];
}

export const FAKE_CAPABILITIES: CapabilitySet = {
  non_interactive: true,
  cwd: true,
  file_output: true,
  streaming_events: true,
  structured_output: 'prompt-only',
  resume: true,
  model_select: true,
  effort_select: true,
  sandbox: { read_only: true, workspace_write: true, network_off: true },
  command_allowlist: false,
  command_denylist: false,
  file_scope: false,
  usage_report: true,
  rate_limit_signal: false,
  max_turns: false,
  background: false,
  notes: ['scripted adapter; spawns nothing'],
};

export function createFakeAdapter(options: FakeAdapterOptions): FakeAdapter {
  const jobs: WorkerJob[] = [];
  const cursors: Partial<Record<Role, number>> = {};

  const nextStep = (job: WorkerJob): FakeStep => {
    if (typeof options.script === 'function') return options.script(job, jobs.length - 1);
    const steps = options.script[job.role] ?? [];
    const i = cursors[job.role] ?? 0;
    cursors[job.role] = i + 1;
    const step = steps[i];
    if (!step) throw new Error(`fake adapter: no scripted step #${i} for role ${job.role}`);
    return step;
  };

  return {
    id: options.id ?? 'fake',
    apiVersion: ADAPTER_API_VERSION,
    jobs,

    async detect(opts: DetectOptions): Promise<Detection> {
      return {
        binary_abs: '/dev/null/fake',
        version: '0.0.0-fake',
        binary_mtime_ms: 0,
        auth: 'ok',
        problems: [],
        vendor_home: opts.vendorHome,
        ...options.detection,
      };
    },

    async capabilities(): Promise<CapabilitySet> {
      return { ...FAKE_CAPABILITIES, ...options.capabilities };
    },

    start(job: WorkerJob): WorkerHandle {
      jobs.push(job);
      const step = nextStep(job);
      const started = Date.now();
      const queue = new AsyncQueue<WorkerEvent>();
      const now = (): string => new Date().toISOString();
      const sessionRef = `fake-session-${jobs.length}`;
      let killed: KillReason | undefined;
      let wake: (() => void) | undefined;

      const result = (async (): Promise<WorkerResult> => {
        queue.push({ t: now(), kind: 'started', session_ref: sessionRef, model_id: job.model_id, raw: { fake: true } });
        if (step.delay_ms) await new Promise((r) => setTimeout(r, step.delay_ms));
        if (step.hang) await new Promise<void>((r) => (wake = r));

        if (!killed) {
          for (const [rel, content] of Object.entries(step.writes ?? {})) {
            const abs = join(job.cwd_abs, rel);
            if (content === null) rmSync(abs, { force: true });
            else {
              mkdirSync(dirname(abs), { recursive: true });
              writeFileSync(abs, content);
              queue.push({ t: now(), kind: 'file_change', path: rel, op: 'modify', raw: { fake: true } });
            }
          }
          await step.run?.(job);
          const outFile = job.output.files[0];
          if (outFile && (step.output_raw !== undefined || step.output !== undefined)) {
            const abs = join(job.cwd_abs, outFile.path_rel);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, step.output_raw ?? JSON.stringify(step.output, null, 2));
          }
          for (const ev of step.events ?? []) queue.push(ev);
        }

        const finalText = step.final_text ?? 'done';
        if (!killed) {
          queue.push({ t: now(), kind: 'assistant_text', text: finalText, partial: false, raw: { fake: true } });
          queue.push({ t: now(), kind: 'usage', input_tokens: 100, output_tokens: 10, raw: { fake: true } });
        }
        const classification: Classification = killed ?? step.classification ?? 'ok';
        const exitCode = killed ? null : step.exit_code === undefined ? (classification === 'ok' ? 0 : 1) : step.exit_code;
        queue.push({
          t: now(),
          kind: 'ended',
          exit_code: exitCode,
          reason: killed ? (killed === 'killed' ? 'killed' : 'timeout') : classification === 'ok' ? 'completed' : 'crashed',
        });
        queue.close();
        return {
          exit_code: exitCode,
          classification,
          final_text: killed ? '' : finalText,
          session_ref: sessionRef,
          usage: { input_tokens: 100, output_tokens: 10 },
          duration_ms: Date.now() - started,
          argv: ['fake', job.role],
          optional_flags_used: [],
          events_path_abs: join(job.log_dir_abs, 'events.jsonl'),
          ...(step.detail ? { detail: step.detail } : {}),
        };
      })();

      return {
        pid: process.pid,
        pgid: -1,
        session_ref: () => sessionRef,
        events: queue,
        result,
        kill(_signal, reason = 'killed') {
          killed ??= reason;
          wake?.();
        },
      };
    },
  };
}

export default createFakeAdapter;

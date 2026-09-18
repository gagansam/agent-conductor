/**
 * Shared process plumbing for adapters that spawn a CLI and parse its stdout.
 *
 * Guarantees the core relies on: the child runs in its own process group,
 * stdin is closed (or fed once and closed), stdout/stderr are teed to log
 * files, and kill() signals the whole group.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Classification,
  EndReason,
  KillReason,
  WorkerEvent,
  WorkerHandle,
  WorkerResult,
  WorkerUsage,
} from './types.js';

export interface CliSpawnSpec {
  binary: string;
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** Written to stdin, which is then closed. When absent stdin is closed immediately. */
  stdin?: string;
}

export interface CliOutputLine {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface CliExit {
  code: number | null;
  signal: string | null;
  /** Set when the process could not be started at all. */
  spawn_error?: string;
}

export interface CliProcess {
  pid: number;
  pgid: number;
  lines: AsyncIterable<CliOutputLine>;
  exit: Promise<CliExit>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

export type SpawnCli = (spec: CliSpawnSpec) => CliProcess;

/** A minimal unbounded async queue: push from callbacks, consume with for-await. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function lineSplitter(onLine: (line: string) => void): { write(chunk: string): void; flush(): void } {
  let buf = '';
  return {
    write(chunk) {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        onLine(line);
      }
    },
    flush() {
      if (buf.length > 0) onLine(buf);
      buf = '';
    },
  };
}

/** The real spawner. Detached so the CLI and all its children share one process group. */
export const spawnCli: SpawnCli = (spec) => {
  const queue = new AsyncQueue<CliOutputLine>();
  const child = nodeSpawn(spec.binary, spec.argv, {
    cwd: spec.cwd,
    env: spec.env as NodeJS.ProcessEnv,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const out = lineSplitter((line) => queue.push({ stream: 'stdout', line }));
  const err = lineSplitter((line) => queue.push({ stream: 'stderr', line }));
  child.stdout.setEncoding('utf8').on('data', (c: string) => out.write(c));
  child.stderr.setEncoding('utf8').on('data', (c: string) => err.write(c));

  child.stdin.on('error', () => {});
  if (spec.stdin !== undefined) child.stdin.end(spec.stdin);
  else child.stdin.end();

  const exit = new Promise<CliExit>((resolve) => {
    let spawnError: string | undefined;
    child.on('error', (e) => {
      spawnError = e.message;
      // 'close' does not fire when the process never started.
      if (child.pid === undefined) {
        queue.close();
        resolve({ code: null, signal: null, spawn_error: spawnError });
      }
    });
    child.on('close', (code, signal) => {
      out.flush();
      err.flush();
      queue.close();
      resolve({ code, signal, ...(spawnError ? { spawn_error: spawnError } : {}) });
    });
  });

  const pid = child.pid ?? -1;
  return {
    pid,
    pgid: pid,
    lines: queue,
    exit,
    kill(signal) {
      if (pid <= 0) return;
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    },
  };
};

/** Vendor-specific behaviour plugged into the shared run loop. */
export interface VendorDriver {
  /** Parse one stdout line into zero or more normalized events. Must not throw. */
  parseStdoutLine(line: string, now: () => string): WorkerEvent[];
  /** Never exit code alone: look at events and stderr too. */
  classify(input: ClassifyInput): { classification: Classification; detail?: string };
}

export interface ClassifyInput {
  exit_code: number | null;
  signal: string | null;
  spawn_error?: string;
  events: WorkerEvent[];
  stderr: string;
  final_text: string;
}

export interface RunCliWorkerSpec {
  spawn: SpawnCli;
  spec: CliSpawnSpec;
  driver: VendorDriver;
  log_dir_abs: string;
  /** argv as it should be recorded (secrets already redacted). */
  recorded_argv: string[];
  optional_flags_used: string[];
  now?: () => string;
}

const KILL_TO_END: Record<KillReason, EndReason> = {
  killed: 'killed',
  timeout_idle: 'timeout',
  timeout_total: 'timeout',
};

/**
 * Runs a CLI to completion, normalizing its output into WorkerEvents and a
 * WorkerResult. Writes stdout.log, stderr.log and events.jsonl into log_dir.
 */
export function runCliWorker(run: RunCliWorkerSpec): WorkerHandle {
  const now = run.now ?? (() => new Date().toISOString());
  const started = Date.now();
  mkdirSync(run.log_dir_abs, { recursive: true });
  const eventsPath = join(run.log_dir_abs, 'events.jsonl');
  const stdoutLog = createWriteStream(join(run.log_dir_abs, 'stdout.log'));
  const stderrLog = createWriteStream(join(run.log_dir_abs, 'stderr.log'));
  const eventsLog = createWriteStream(eventsPath);

  const proc = run.spawn(run.spec);
  const queue = new AsyncQueue<WorkerEvent>();
  const seen: WorkerEvent[] = [];
  let sessionRef: string | undefined;
  let finalText = '';
  let usage: WorkerUsage | undefined;
  let stderrText = '';
  let killReason: KillReason | undefined;
  let startedEmitted = false;

  const emit = (ev: WorkerEvent): void => {
    if (ev.kind === 'started') {
      if (ev.session_ref) sessionRef = ev.session_ref;
      if (startedEmitted) return;
      startedEmitted = true;
    } else if (!startedEmitted && ev.kind !== 'ended') {
      // The contract says `started` comes first, even if the vendor never says so.
      startedEmitted = true;
      const synthetic: WorkerEvent = { t: ev.t, kind: 'started', raw: { synthetic: true } };
      seen.push(synthetic);
      eventsLog.write(JSON.stringify(synthetic) + '\n');
      queue.push(synthetic);
    }
    if (ev.kind === 'assistant_text' && !ev.partial) finalText = ev.text;
    if (ev.kind === 'usage') {
      usage = {
        input_tokens: ev.input_tokens ?? usage?.input_tokens,
        cached_input_tokens: ev.cached_input_tokens ?? usage?.cached_input_tokens,
        output_tokens: ev.output_tokens ?? usage?.output_tokens,
        cost_usd: ev.cost_usd ?? usage?.cost_usd,
        raw: ev.raw,
      };
    }
    seen.push(ev);
    eventsLog.write(JSON.stringify(ev) + '\n');
    queue.push(ev);
  };

  const closeStream = (s: NodeJS.WritableStream): Promise<void> =>
    new Promise((resolve) => s.end(() => resolve()));

  const result = (async (): Promise<WorkerResult> => {
    for await (const { stream, line } of proc.lines) {
      if (stream === 'stderr') {
        stderrLog.write(line + '\n');
        if (stderrText.length < 256_000) stderrText += line + '\n';
        continue;
      }
      stdoutLog.write(line + '\n');
      let parsed: WorkerEvent[] = [];
      try {
        parsed = run.driver.parseStdoutLine(line, now);
      } catch (e) {
        parsed = [{ t: now(), kind: 'warning', code: 'parse_error', message: String(e), raw: line }];
      }
      for (const ev of parsed) emit(ev);
    }
    const exit = await proc.exit;

    let classification: Classification;
    let detail: string | undefined;
    if (killReason) {
      classification = killReason;
      detail = `killed by conductor: ${killReason}`;
    } else {
      const c = run.driver.classify({
        exit_code: exit.code,
        signal: exit.signal,
        ...(exit.spawn_error ? { spawn_error: exit.spawn_error } : {}),
        events: seen,
        stderr: stderrText,
        final_text: finalText,
      });
      classification = c.classification;
      detail = c.detail;
    }
    const reason: EndReason = killReason
      ? KILL_TO_END[killReason]
      : classification === 'ok'
        ? 'completed'
        : 'crashed';
    if (!startedEmitted) emit({ t: now(), kind: 'started', raw: { synthetic: true } });
    emit({ t: now(), kind: 'ended', exit_code: exit.code, reason });
    queue.close();
    await Promise.all([closeStream(stdoutLog), closeStream(stderrLog), closeStream(eventsLog)]);

    return {
      exit_code: exit.code,
      classification,
      final_text: finalText,
      ...(sessionRef ? { session_ref: sessionRef } : {}),
      ...(usage ? { usage } : {}),
      duration_ms: Date.now() - started,
      argv: run.recorded_argv,
      optional_flags_used: run.optional_flags_used,
      events_path_abs: eventsPath,
      ...(detail ? { detail } : {}),
    };
  })();

  return {
    pid: proc.pid,
    pgid: proc.pgid,
    session_ref: () => sessionRef,
    events: queue,
    result,
    kill(signal, reason = 'killed') {
      killReason ??= reason;
      proc.kill(signal);
    },
  };
}

/** An argv builder that remembers which capability justified each optional flag. */
export class ArgvBuilder {
  private args: string[] = [];
  private used = new Set<string>();
  constructor(private readonly dropOptional: boolean) {}

  required(...args: string[]): this {
    this.args.push(...args);
    return this;
  }

  /** Added only when `enabled` and optional flags have not been dropped. */
  optional(capability: string, enabled: boolean, ...args: string[]): this {
    if (!enabled || this.dropOptional) return this;
    this.args.push(...args);
    this.used.add(capability);
    return this;
  }

  build(): { argv: string[]; optional_flags_used: string[] } {
    return { argv: [...this.args], optional_flags_used: [...this.used].sort() };
  }
}

/** Tolerant JSON parse for stream lines. */
export function tryParseJson(line: string): unknown | undefined {
  const s = line.trim();
  if (!s.startsWith('{')) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

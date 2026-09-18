/**
 * Tier-1 (offline) conformance: replay recorded CLI output through an adapter
 * and assert the contract. No CLI, no network, no quota.
 *
 * Fixture layout, per adapter package:
 *
 *   fixtures/<cli-version>/help.txt            `--help` text captured from that version
 *   fixtures/<cli-version>/caps.json           expected (partial) CapabilitySet for help.txt
 *   fixtures/<cli-version>/<case>/stdout.txt   recorded stdout
 *   fixtures/<cli-version>/<case>/stderr.txt   recorded stderr (optional)
 *   fixtures/<cli-version>/<case>/meta.json    { exit_code, expect: { classification, final_text?, has_usage? } }
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncQueue, type CliOutputLine, type CliSpawnSpec, type SpawnCli } from '../process.js';
import type {
  CapabilitySet,
  Classification,
  Detection,
  SandboxPolicy,
  WorkerAdapter,
  WorkerEvent,
  WorkerJob,
} from '../types.js';

export interface FixtureCase {
  version: string;
  name: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  expect: { classification: Classification; final_text?: string; has_usage?: boolean };
}

export interface FixtureVersion {
  version: string;
  help_text?: string;
  expected_caps?: Partial<CapabilitySet>;
  cases: FixtureCase[];
}

export function loadFixtures(fixturesDir: string): FixtureVersion[] {
  if (!existsSync(fixturesDir)) return [];
  const versions: FixtureVersion[] = [];
  for (const version of readdirSync(fixturesDir).sort()) {
    const vdir = join(fixturesDir, version);
    if (!statSync(vdir).isDirectory()) continue;
    const fv: FixtureVersion = { version, cases: [] };
    const help = join(vdir, 'help.txt');
    if (existsSync(help)) fv.help_text = readFileSync(help, 'utf8');
    const caps = join(vdir, 'caps.json');
    if (existsSync(caps)) fv.expected_caps = JSON.parse(readFileSync(caps, 'utf8')) as Partial<CapabilitySet>;
    for (const name of readdirSync(vdir).sort()) {
      const cdir = join(vdir, name);
      if (!statSync(cdir).isDirectory()) continue;
      const meta = JSON.parse(readFileSync(join(cdir, 'meta.json'), 'utf8')) as {
        exit_code: number | null;
        expect: FixtureCase['expect'];
      };
      const read = (f: string): string => (existsSync(join(cdir, f)) ? readFileSync(join(cdir, f), 'utf8') : '');
      fv.cases.push({
        version,
        name,
        stdout: read('stdout.txt'),
        stderr: read('stderr.txt'),
        exit_code: meta.exit_code,
        expect: meta.expect,
      });
    }
    versions.push(fv);
  }
  return versions;
}

/** A SpawnCli that replays recorded output and records what it was asked to run. */
export function replaySpawn(
  recorded: { stdout: string; stderr: string; exit_code: number | null },
  seen?: CliSpawnSpec[],
): SpawnCli {
  return (spec) => {
    seen?.push(spec);
    const q = new AsyncQueue<CliOutputLine>();
    const split = (s: string): string[] => (s.length ? s.replace(/\n$/, '').split('\n') : []);
    // stderr first mirrors reality closely enough: CLIs print config errors before any stdout.
    for (const line of split(recorded.stderr)) q.push({ stream: 'stderr', line });
    for (const line of split(recorded.stdout)) q.push({ stream: 'stdout', line });
    q.close();
    return {
      pid: 4242,
      pgid: 4242,
      lines: q,
      exit: Promise.resolve({ code: recorded.exit_code, signal: null }),
      kill() {},
    };
  };
}

export interface ConformanceTarget {
  /** Build the adapter with an injected spawner. */
  createAdapter(spawn: SpawnCli): WorkerAdapter;
  fixturesDir: string;
  /** A fake Detection for a fixture version (no binary is ever executed offline). */
  detection(version: string, helpText: string | undefined, vendorHome: string): Detection;
  /** The operator's real vendor home; must never appear in argv. */
  operatorHome: string;
  /** True when this argv would let the CLI write files. Used to check fs: 'read-only'. */
  isWriteEnabling(argv: string[]): boolean;
  /**
   * How a denied command pattern is enforced: visible in argv, or by some
   * documented mechanism outside argv (sandbox mode, prompt + audit).
   */
  denyEnforcement(argv: string[], pattern: string): 'argv' | 'documented' | 'missing';
}

export interface CheckResult {
  id: string;
  subject: string;
  ok: boolean;
  message: string;
}

const REQUIRED_CASE_LABELS: Classification[] = ['ok'];

export function sampleJob(cwd: string, logDir: string, overrides: Partial<WorkerJob> = {}): WorkerJob {
  const policy: SandboxPolicy = {
    fs: 'workspace-write',
    network: false,
    allowed_commands: ['pnpm test*', 'git diff*'],
    denied_commands: ['git commit*', 'git push*'],
    extra_readable_dirs_abs: [],
  };
  return {
    worker_run_id: 'conformance-run',
    role: 'implementer',
    cwd_abs: cwd,
    prompt: 'conformance prompt',
    model_id: 'conformance-model',
    effort: 'high',
    policy,
    output: {
      dir_rel: '.conductor/out',
      files: [{ path_rel: '.conductor/out/report.json', schema: { type: 'object' } }],
    },
    timeouts: { idle_ms: 60_000, total_ms: 120_000 },
    env: {},
    log_dir_abs: logDir,
    ...overrides,
  };
}

async function drain(events: AsyncIterable<WorkerEvent>): Promise<WorkerEvent[]> {
  const out: WorkerEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** Runs every offline assertion from docs/04-worker-adapter-contract.md. */
export async function runOfflineConformance(target: ConformanceTarget): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = (id: string, subject: string, ok: boolean, message: string): void => {
    results.push({ id, subject, ok, message: ok ? 'ok' : message });
  };
  const versions = loadFixtures(target.fixturesDir);
  check('fixtures.present', target.fixturesDir, versions.some((v) => v.cases.length > 0), 'no fixture cases found');
  const labels = new Set(versions.flatMap((v) => v.cases.map((c) => c.expect.classification)));
  for (const label of REQUIRED_CASE_LABELS) {
    check('fixtures.coverage', label, labels.has(label), `no fixture labelled "${label}"`);
  }

  const tmp = mkdtempSync(join(tmpdir(), 'conductor-conformance-'));
  const vendorHome = join(tmp, 'vendor-home');
  try {
    for (const v of versions) {
      const detection = target.detection(v.version, v.help_text, vendorHome);

      // 10. capabilities() for this version's help text.
      let caps: CapabilitySet | undefined;
      try {
        caps = await target.createAdapter(replaySpawn({ stdout: '', stderr: '', exit_code: 0 })).capabilities(detection);
        const required = caps.non_interactive === true && caps.cwd === true && caps.file_output === true;
        check('caps.required', v.version, required, 'required capabilities must all be true');
        for (const [k, expected] of Object.entries(v.expected_caps ?? {})) {
          const actual = (caps as unknown as Record<string, unknown>)[k];
          check(
            'caps.expected',
            `${v.version}:${k}`,
            JSON.stringify(actual) === JSON.stringify(expected),
            `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
          );
        }
      } catch (e) {
        check('caps.required', v.version, false, `capabilities() threw: ${String(e)}`);
      }
      if (!caps) continue;

      for (const c of v.cases) {
        const subject = `${v.version}/${c.name}`;
        const seenSpecs: CliSpawnSpec[] = [];
        const adapter = target.createAdapter(replaySpawn(c, seenSpecs));
        const job = sampleJob(join(tmp, 'cwd'), join(tmp, 'logs', v.version, c.name));
        const handle = adapter.start(job, detection, caps);
        const [events, result] = await Promise.all([drain(handle.events), handle.result]);

        // 1. started first, ended last, timestamps monotonic.
        const first = events[0];
        const last = events[events.length - 1];
        check('events.order', subject, first?.kind === 'started' && last?.kind === 'ended', 'events must begin with started and end with ended');
        const times = events.map((e) => Date.parse(e.t));
        check('events.monotonic', subject, times.every((t, i) => i === 0 || t >= (times[i - 1] ?? 0)), 'timestamps must not go backwards');
        // 2. raw on everything except ended.
        check('events.raw', subject, events.every((e) => e.kind === 'ended' || e.raw !== undefined), 'every event except ended must carry raw');
        // 3. classification matches the label.
        check('classify.label', subject, result.classification === c.expect.classification, `expected ${c.expect.classification}, got ${result.classification} (${result.detail ?? ''})`);
        // 4. exit 0 with an error event is not ok.
        if (c.exit_code === 0 && events.some((e) => e.kind === 'error')) {
          check('classify.exit0-error', subject, result.classification !== 'ok', 'exit 0 plus an error event must not classify ok');
        }
        // 5. final_text.
        if (c.expect.final_text !== undefined) {
          check('result.final_text', subject, result.final_text === c.expect.final_text, `expected ${JSON.stringify(c.expect.final_text)}, got ${JSON.stringify(result.final_text)}`);
        }
        // 6. usage.
        if (c.expect.has_usage) {
          const u = result.usage;
          check('result.usage', subject, !!u && (u.input_tokens !== undefined || u.output_tokens !== undefined), 'usage expected but missing');
        }
        // 8. vendor home isolation.
        const spec = seenSpecs[0];
        check('argv.no-operator-home', subject, !!spec && !spec.argv.some((a) => a.includes(target.operatorHome)), 'argv must not reference the operator vendor home');
        const envValues = Object.values(spec?.env ?? {}).filter((x): x is string => typeof x === 'string');
        const argvOrEnvHasVendorHome = envValues.some((x) => x.includes(vendorHome)) || !!spec?.argv.some((a) => a.includes(vendorHome));
        check('env.vendor-home', subject, argvOrEnvHasVendorHome, 'the conductor vendor home must be passed via env or argv');
      }

      // 7. no optional flags when dropped. 9. policy translation.
      const specs: CliSpawnSpec[] = [];
      const adapter = target.createAdapter(replaySpawn({ stdout: '', stderr: '', exit_code: 0 }, specs));
      const bare = adapter.start(sampleJob(join(tmp, 'cwd'), join(tmp, 'logs', v.version, '_bare'), { no_optional_flags: true }), detection, caps);
      await drain(bare.events);
      const bareResult = await bare.result;
      check('argv.bare', v.version, bareResult.optional_flags_used.length === 0, `optional flags present after drop: ${bareResult.optional_flags_used.join(',')}`);

      const roPolicy: SandboxPolicy = { fs: 'read-only', network: false, allowed_commands: [], denied_commands: ['git commit*'], extra_readable_dirs_abs: [] };
      const ro = adapter.start(sampleJob(join(tmp, 'cwd'), join(tmp, 'logs', v.version, '_ro'), { policy: roPolicy }), detection, caps);
      await drain(ro.events);
      await ro.result;
      const roArgv = specs[specs.length - 1]?.argv ?? [];
      check('policy.read-only', v.version, !target.isWriteEnabling(roArgv), `read-only policy produced write-enabling argv: ${roArgv.join(' ')}`);
      check('policy.deny', v.version, target.denyEnforcement(roArgv, 'git commit*') !== 'missing', 'denied command neither in argv nor documented as enforced elsewhere');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return results;
}

export function formatResults(results: CheckResult[]): string {
  return results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.id} [${r.subject}]${r.ok ? '' : ` — ${r.message}`}`).join('\n');
}

export * from './live.js';

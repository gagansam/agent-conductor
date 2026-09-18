/**
 * Worker adapter for Codex CLI. Spawns `codex exec --json` (ADR-0001) against
 * a conductor-owned CODEX_HOME that borrows only the operator's login
 * (ADR-0009): the operator's config.toml is written by other Codex products
 * and cannot be assumed loadable by this binary.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ADAPTER_API_VERSION,
  ArgvBuilder,
  capture,
  findBinary,
  helpHasFlag,
  runCliWorker,
  spawnCli,
  type CapabilitySet,
  type Detection,
  type DetectOptions,
  type SpawnCli,
  type WorkerAdapter,
  type WorkerHandle,
  type WorkerJob,
} from '@agent-conductor/adapter-api';
import { codexDriver } from './events.js';

export interface CodexAdapterOptions {
  spawn?: SpawnCli;
  /** Also pass the output schema through --output-schema. Off by default: the file protocol is the contract. */
  native_structured_output?: boolean;
}

const CONFIG_TOML = `# Managed by agent-conductor. Workers never read the operator's ~/.codex/config.toml.
# Model, sandbox and effort are passed per invocation.
`;

/** Point vendorHome/auth.json at the operator's login. Returns a problem description, or undefined when fine. */
export function linkAuth(vendorHome: string, operatorHome: string): string | undefined {
  mkdirSync(vendorHome, { recursive: true });
  const source = join(operatorHome, 'auth.json');
  const link = join(vendorHome, 'auth.json');
  if (!existsSync(source)) return `${source} does not exist; run \`codex login\``;
  let st;
  try {
    st = lstatSync(link);
  } catch {
    st = undefined;
  }
  if (st?.isSymbolicLink() && readlinkSync(link) === source) return undefined;
  if (st && !st.isSymbolicLink()) {
    // Codex replaced our symlink with a file (a token refresh written by rename). The operator's own
    // login may now be stale; say so rather than silently relinking over a possibly newer token.
    return `${link} is a regular file, not a symlink to ${source}. A token refresh may have landed here instead of in your own login. Compare the two files, keep the newer as ${source}, delete ${link}, and re-run.`;
  }
  if (st) unlinkSync(link);
  symlinkSync(source, link);
  return undefined;
}

export function buildCodexArgv(job: WorkerJob, caps: CapabilitySet, help: string, opts: CodexAdapterOptions, schemaFile?: string): { argv: string[]; optional_flags_used: string[] } {
  const b = new ArgvBuilder(job.no_optional_flags === true);
  const has = (flag: string): boolean => helpHasFlag(help, flag);

  // Every flag goes BEFORE `resume`. On 0.3x `exec resume` itself accepts only -c and --last, so
  // `exec resume <id> --json` is a usage error there, while `exec --json … resume <id>` parses on
  // every version tried (0.36, 0.145). Verified by hand; see docs/13-environment-findings.md.
  b.required('exec', '--json', '--skip-git-repo-check');
  // No version's `exec resume` takes -s; the config override works with and without resume.
  b.required('-c', `sandbox_mode="${job.policy.fs === 'read-only' ? 'read-only' : 'workspace-write'}"`);

  b.optional('model_select', caps.model_select && !!job.model_id, '-m', job.model_id ?? '');
  b.optional('effort_select', caps.effort_select && !!job.effort, '-c', `model_reasoning_effort="${job.effort ?? ''}"`);
  b.optional('network', job.policy.network && job.policy.fs === 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true');
  b.optional('settings_isolation', has('--ignore-user-config'), '--ignore-user-config');
  b.optional('rules_isolation', has('--ignore-rules'), '--ignore-rules');
  b.optional('structured_output', opts.native_structured_output === true && caps.structured_output === 'native' && !!schemaFile && !job.resume, '--output-schema', schemaFile ?? '');

  if (job.resume && caps.resume) b.required('resume', job.resume.session_ref);
  // "-" ⇒ read the prompt from stdin; stdin is then closed, so Codex can never wait on it.
  b.required('-');
  return b.build();
}

export function createAdapter(options: CodexAdapterOptions = {}): WorkerAdapter {
  const spawn = options.spawn ?? spawnCli;
  return {
    id: 'codex',
    apiVersion: ADAPTER_API_VERSION,

    async detect(opts: DetectOptions): Promise<Detection> {
      const problems: Detection['problems'] = [];
      const binary = findBinary(opts.binary ?? 'codex');
      if (!binary) {
        return { binary_abs: opts.binary ?? 'codex', version: 'unknown', binary_mtime_ms: 0, auth: 'unknown', vendor_home: opts.vendorHome, problems: [{ code: 'binary_not_found', message: `codex not found (${opts.binary ?? 'searched PATH'})`, fatal: true }] };
      }
      const operatorHome = opts.operatorHome ?? join(homedir(), '.codex');
      const authProblem = linkAuth(opts.vendorHome, operatorHome);
      if (authProblem) problems.push({ code: 'auth', message: authProblem, fatal: true });
      writeFileSync(join(opts.vendorHome, 'config.toml'), CONFIG_TOML);

      // Every probe runs against the isolated home: the operator's config may not even parse.
      const env = { ...process.env, CODEX_HOME: opts.vendorHome };
      const v = await capture(binary, ['--version'], { env });
      const version = /(\d+\.\d+\.\d+[^\s]*)/.exec(v.stdout)?.[1] ?? 'unknown';
      if (v.code !== 0) problems.push({ code: 'version_failed', message: `codex --version exited ${v.code}: ${v.stderr.trim().slice(0, 200)}`, fatal: true });
      const help = await capture(binary, ['exec', '--help'], { env });
      if (help.code !== 0 || !helpHasFlag(help.stdout, '--json')) problems.push({ code: 'no_exec_json', message: 'this codex has no `exec --json` mode', fatal: true });
      const top = await capture(binary, ['--help'], { env });

      const operatorConfig = join(operatorHome, 'config.toml');
      if (existsSync(operatorConfig)) {
        const probe = await capture(binary, ['exec', '--help'], { env: { ...process.env, CODEX_HOME: operatorHome } });
        if (probe.code !== 0) problems.push({ code: 'operator_config_unloadable', message: `this codex cannot load ${operatorConfig} (${probe.stderr.trim().split('\n').pop()?.slice(0, 160)}). Workers are unaffected: they use ${opts.vendorHome}.`, fatal: false });
      }
      return { binary_abs: binary, version, binary_mtime_ms: statSync(binary).mtimeMs, auth: authProblem ? 'missing' : 'ok', problems, help_text: `${help.stdout}\n${top.stdout}`, vendor_home: opts.vendorHome };
    },

    async capabilities(d: Detection): Promise<CapabilitySet> {
      const help = d.help_text ?? '';
      const has = (flag: string): boolean => helpHasFlag(help, flag);
      const notes = ['no per-command allow/deny list: git mutation is prevented by refusing hooks and detected by the post-run audit', 'no rate-limit signal observed in `exec --json`'];
      if (!has('--ignore-user-config')) notes.push('no --ignore-user-config: isolation relies on CODEX_HOME alone');
      return {
        non_interactive: true,
        cwd: true,
        file_output: true,
        streaming_events: true,
        structured_output: has('--output-schema') ? 'native' : 'prompt-only',
        resume: /\bresume\b/.test(help),
        model_select: has('--model'),
        effort_select: true,
        sandbox: { read_only: true, workspace_write: true, network_off: true },
        command_allowlist: false,
        command_denylist: false,
        file_scope: has('--add-dir'),
        usage_report: true,
        rate_limit_signal: false,
        max_turns: false,
        background: false,
        notes,
      };
    },

    start(job: WorkerJob, d: Detection, caps: CapabilitySet): WorkerHandle {
      let schemaFile: string | undefined;
      const schema = job.output.files[0]?.schema;
      if (options.native_structured_output && schema) {
        mkdirSync(job.log_dir_abs, { recursive: true });
        schemaFile = join(job.log_dir_abs, 'output-schema.json');
        writeFileSync(schemaFile, JSON.stringify(schema));
      }
      const { argv, optional_flags_used } = buildCodexArgv(job, caps, d.help_text ?? '', options, schemaFile);
      return runCliWorker({
        spawn,
        spec: { binary: d.binary_abs, argv, cwd: job.cwd_abs, env: { ...process.env, ...job.env, CODEX_HOME: d.vendor_home }, stdin: job.prompt },
        driver: codexDriver,
        log_dir_abs: job.log_dir_abs,
        recorded_argv: [d.binary_abs, ...argv],
        optional_flags_used,
      });
    },
  };
}

export default createAdapter;
export { codexDriver, parseCodexLine } from './events.js';

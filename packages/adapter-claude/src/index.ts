/**
 * Worker adapter for Claude Code. Spawns `claude -p` and parses its
 * stream-json output (ADR-0001). Runs against conductor-owned settings and
 * ignores the operator's user-level settings, global CLAUDE.md and MCP
 * servers (ADR-0009). Authentication is the CLI's own login, untouched.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
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
  type SandboxPolicy,
  type SpawnCli,
  type WorkerAdapter,
  type WorkerHandle,
  type WorkerJob,
} from '@agent-conductor/adapter-api';
import { claudeDriver } from './events.js';

export interface ClaudeAdapterOptions {
  spawn?: SpawnCli;
  /** Also pass the output schema through --json-schema. Off by default: the file protocol is the contract. */
  native_structured_output?: boolean;
  /** Use --restricted for read-only jobs instead of a tool denylist. */
  restricted_read_only?: boolean;
}

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'TodoWrite'];
const NETWORK_TOOLS = ['WebFetch', 'WebSearch'];

/** "pnpm test*" → Bash(pnpm test:*) (prefix rule); "pwd" → Bash(pwd) (exact rule). */
export function toBashRule(pattern: string): string {
  const p = pattern.trim();
  if (p.endsWith('*')) return `Bash(${p.slice(0, -1).trimEnd()}:*)`;
  return `Bash(${p})`;
}

export function settingsPath(vendorHome: string): string {
  return join(vendorHome, 'settings.json');
}

/** Deny rules live in the settings file as well as argv, so they survive a retry that drops optional flags. */
function writeSettings(vendorHome: string, policy: SandboxPolicy): string {
  mkdirSync(vendorHome, { recursive: true });
  const file = settingsPath(vendorHome);
  const deny = [...policy.denied_commands.map(toBashRule), ...(policy.network ? [] : NETWORK_TOOLS), ...(policy.fs === 'read-only' ? EDIT_TOOLS : [])];
  writeFileSync(file, JSON.stringify({ includeCoAuthoredBy: false, permissions: { deny } }, null, 2));
  return file;
}

export function buildClaudeArgv(job: WorkerJob, caps: CapabilitySet, help: string, vendorHome: string, opts: ClaudeAdapterOptions): { argv: string[]; optional_flags_used: string[] } {
  const b = new ArgvBuilder(job.no_optional_flags === true);
  const has = (flag: string): boolean => helpHasFlag(help, flag);
  const writable = job.policy.fs === 'workspace-write';

  // The narrow contract: headless, machine-readable, settings we own. Prompt arrives on stdin.
  b.required('-p', '--output-format', 'stream-json', '--verbose');
  b.required('--settings', writeSettings(vendorHome, job.policy));
  if (writable) b.required('--permission-mode', 'acceptEdits');

  if (job.resume && caps.resume) b.required('--resume', job.resume.session_ref);

  b.optional('settings_isolation', has('--setting-sources'), '--setting-sources', 'project');
  b.optional('mcp_isolation', has('--strict-mcp-config'), '--strict-mcp-config');
  b.optional('no_prompts', has('--permission-prompts'), '--permission-prompts', 'none');
  b.optional('model_select', caps.model_select && !!job.model_id, '--model', job.model_id ?? '');
  b.optional('effort_select', caps.effort_select && !!job.effort, '--effort', job.effort ?? '');

  if (!writable && opts.restricted_read_only && has('--restricted')) b.optional('file_scope', true, '--restricted');
  const allowed = [...READ_TOOLS, ...(writable ? EDIT_TOOLS : []), ...job.policy.allowed_commands.map(toBashRule)];
  b.optional('command_allowlist', caps.command_allowlist, '--allowed-tools', allowed.join(','));
  const denied = [...job.policy.denied_commands.map(toBashRule), ...(job.policy.network ? [] : NETWORK_TOOLS), ...(writable ? [] : EDIT_TOOLS)];
  b.optional('command_denylist', caps.command_denylist && denied.length > 0, '--disallowed-tools', denied.join(','));
  for (const dir of job.policy.extra_readable_dirs_abs) b.optional('file_scope', caps.file_scope, '--add-dir', dir);

  const schema = job.output.files[0]?.schema;
  b.optional('structured_output', opts.native_structured_output === true && caps.structured_output === 'native' && !!schema, '--json-schema', JSON.stringify(schema ?? {}));
  return b.build();
}

export function createAdapter(options: ClaudeAdapterOptions = {}): WorkerAdapter {
  const spawn = options.spawn ?? spawnCli;
  return {
    id: 'claude',
    apiVersion: ADAPTER_API_VERSION,

    async detect(opts: DetectOptions): Promise<Detection> {
      const problems: Detection['problems'] = [];
      const binary = findBinary(opts.binary ?? 'claude');
      if (!binary) {
        return { binary_abs: opts.binary ?? 'claude', version: 'unknown', binary_mtime_ms: 0, auth: 'unknown', vendor_home: opts.vendorHome, problems: [{ code: 'binary_not_found', message: `claude not found (${opts.binary ?? 'searched PATH'})`, fatal: true }] };
      }
      const v = await capture(binary, ['--version']);
      const version = /(\d+\.\d+\.\d+[^\s]*)/.exec(v.stdout)?.[1] ?? 'unknown';
      if (v.code !== 0) problems.push({ code: 'version_failed', message: `claude --version exited ${v.code}: ${v.stderr.trim().slice(0, 200)}`, fatal: true });
      const help = await capture(binary, ['--help']);
      if (!helpHasFlag(help.stdout, '--print')) problems.push({ code: 'no_headless_mode', message: 'this claude has no -p/--print mode', fatal: true });
      if (!/stream-json/.test(help.stdout)) problems.push({ code: 'no_stream_json', message: 'this claude does not offer --output-format stream-json', fatal: true });
      const operatorHome = opts.operatorHome ?? join(homedir(), '.claude');
      let auth: Detection['auth'] = 'unknown';
      try {
        statSync(operatorHome);
      } catch {
        auth = 'missing';
        problems.push({ code: 'never_logged_in', message: `${operatorHome} does not exist; run \`claude\` once and log in`, fatal: false });
      }
      return { binary_abs: binary, version, binary_mtime_ms: statSync(binary).mtimeMs, auth, problems, help_text: help.stdout, vendor_home: opts.vendorHome };
    },

    async capabilities(d: Detection): Promise<CapabilitySet> {
      const help = d.help_text ?? '';
      const has = (flag: string): boolean => helpHasFlag(help, flag);
      const notes: string[] = [];
      if (!has('--setting-sources')) notes.push('no --setting-sources: the operator\'s user settings and global CLAUDE.md will load into workers');
      if (!has('--strict-mcp-config')) notes.push('no --strict-mcp-config: the operator\'s MCP servers will load into workers');
      notes.push('network is restricted by denying WebFetch/WebSearch and curl/wget patterns, not by a sandbox');
      return {
        non_interactive: true,
        cwd: true,
        file_output: true,
        streaming_events: true,
        structured_output: has('--json-schema') ? 'native' : 'prompt-only',
        resume: has('--resume'),
        model_select: has('--model'),
        effort_select: has('--effort'),
        sandbox: { read_only: true, workspace_write: true, network_off: false },
        command_allowlist: has('--allowed-tools') || has('--allowedTools'),
        command_denylist: has('--disallowed-tools') || has('--disallowedTools'),
        file_scope: has('--add-dir'),
        usage_report: true,
        rate_limit_signal: true,
        max_turns: has('--max-turns'),
        background: has('--bg'),
        notes,
      };
    },

    start(job: WorkerJob, d: Detection, caps: CapabilitySet): WorkerHandle {
      const { argv, optional_flags_used } = buildClaudeArgv(job, caps, d.help_text ?? '', d.vendor_home, options);
      return runCliWorker({
        spawn,
        spec: { binary: d.binary_abs, argv, cwd: job.cwd_abs, env: { ...process.env, ...job.env, CONDUCTOR_VENDOR_HOME: d.vendor_home }, stdin: job.prompt },
        driver: claudeDriver,
        log_dir_abs: job.log_dir_abs,
        recorded_argv: [d.binary_abs, ...argv],
        optional_flags_used,
      });
    },
  };
}

export default createAdapter;
export { claudeDriver, parseClaudeLine } from './events.js';

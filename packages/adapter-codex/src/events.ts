import { tryParseJson, type Classification, type VendorDriver, type WorkerEvent } from '@agent-conductor/adapter-api';

type Json = Record<string, unknown>;
const obj = (x: unknown): Json | undefined => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Json) : undefined);
const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const clip = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

const CHANGE_OP: Record<string, 'create' | 'modify' | 'delete'> = { add: 'create', create: 'create', update: 'modify', modify: 'modify', delete: 'delete', remove: 'delete' };

/**
 * `codex exec --json`. Two unrelated formats exist in the wild and both are
 * handled, selected per line by shape:
 *
 *   thread/turn/item   {"type":"item.completed","item":{...}}      (0.1xx)
 *   id/msg             {"id":"0","msg":{"type":"agent_message"}}   (0.3x)
 *
 * Unknown records are ignored, never fatal.
 */
export function parseCodexLine(line: string, now: () => string): WorkerEvent[] {
  const rec = obj(tryParseJson(line));
  if (!rec) return [];
  const msg = obj(rec.msg);
  return msg ? parseLegacy(rec, msg, now()) : parseThreaded(rec, now());
}

function parseThreaded(rec: Json, t: string): WorkerEvent[] {
  const type = str(rec.type);
  if (type === 'thread.started') {
    const session_ref = str(rec.thread_id);
    return [{ t, kind: 'started', ...(session_ref ? { session_ref } : {}), raw: rec }];
  }
  if (type === 'turn.completed') {
    const u = obj(rec.usage);
    const cached = num(u?.cached_input_tokens);
    const total = num(u?.input_tokens);
    // Codex reports cached tokens as a subset of input_tokens.
    return [{ t, kind: 'usage', ...(total !== undefined ? { input_tokens: total - (cached ?? 0) } : {}), ...(cached !== undefined ? { cached_input_tokens: cached } : {}), ...(num(u?.output_tokens) !== undefined ? { output_tokens: num(u?.output_tokens)! } : {}), raw: rec }];
  }
  if (type === 'turn.failed') return [{ t, kind: 'error', code: 'turn_failed', message: str(obj(rec.error)?.message) ?? 'turn failed', raw: rec }];
  if (type === 'error') return classifyStreamNoise(str(rec.message) ?? 'error', rec, t);

  if (type === 'item.started' || type === 'item.completed' || type === 'item.updated') {
    const item = obj(rec.item);
    if (!item) return [];
    const itemType = str(item.type);
    const id = str(item.id);
    const done = type === 'item.completed';
    if (itemType === 'agent_message' && done) return [{ t, kind: 'assistant_text', text: str(item.text) ?? '', partial: false, raw: rec }];
    if (itemType === 'command_execution') {
      const command = oneLine(str(item.command) ?? '');
      if (type === 'item.started') return [{ t, kind: 'tool_call', ...(id ? { id } : {}), tool: 'shell', summary: clip(command), raw: rec }];
      if (done) {
        const code = num(item.exit_code);
        return [{ t, kind: 'tool_result', ...(id ? { id } : {}), ...(code !== undefined ? { ok: code === 0 } : {}), summary: clip(`exit ${code ?? '?'}: ${oneLine(str(item.aggregated_output) ?? '')}`), raw: rec }];
      }
    }
    if (itemType === 'file_change' && done) {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return changes.flatMap((c): WorkerEvent[] => {
        const ch = obj(c);
        const path = str(ch?.path);
        return path ? [{ t, kind: 'file_change', path, op: CHANGE_OP[str(ch?.kind) ?? ''] ?? 'modify', raw: rec }] : [];
      });
    }
    if ((itemType === 'mcp_tool_call' || itemType === 'web_search') && type === 'item.started') {
      return [{ t, kind: 'tool_call', ...(id ? { id } : {}), tool: itemType, summary: clip(str(item.tool) ?? str(item.query) ?? itemType), raw: rec }];
    }
    if (itemType === 'error' && done) return [{ t, kind: 'warning', code: 'item_error', message: str(item.message) ?? 'item error', raw: rec }];
  }
  return [];
}

function parseLegacy(rec: Json, msg: Json, t: string): WorkerEvent[] {
  const type = str(msg.type);
  switch (type) {
    case 'session_configured': {
      const session_ref = str(msg.session_id);
      const model_id = str(msg.model);
      return [{ t, kind: 'started', ...(session_ref ? { session_ref } : {}), ...(model_id ? { model_id } : {}), raw: rec }];
    }
    case 'task_started':
      return [{ t, kind: 'started', raw: rec }];
    case 'agent_message':
      return [{ t, kind: 'assistant_text', text: str(msg.message) ?? '', partial: false, raw: rec }];
    case 'exec_command_begin': {
      const cmd = Array.isArray(msg.command) ? msg.command.join(' ') : (str(msg.command) ?? '');
      const id = str(msg.call_id);
      return [{ t, kind: 'tool_call', ...(id ? { id } : {}), tool: 'shell', summary: clip(oneLine(cmd)), raw: rec }];
    }
    case 'exec_command_end': {
      const code = num(msg.exit_code);
      const id = str(msg.call_id);
      return [{ t, kind: 'tool_result', ...(id ? { id } : {}), ...(code !== undefined ? { ok: code === 0 } : {}), summary: `exit ${code ?? '?'}`, raw: rec }];
    }
    case 'patch_apply_begin':
      return Object.keys(obj(msg.changes) ?? {}).map((path): WorkerEvent => ({ t, kind: 'file_change', path, op: 'modify', raw: rec }));
    case 'token_count': {
      const u = obj(obj(msg.info)?.total_token_usage) ?? msg;
      return [{ t, kind: 'usage', ...(num(u.input_tokens) !== undefined ? { input_tokens: num(u.input_tokens)! } : {}), ...(num(u.output_tokens) !== undefined ? { output_tokens: num(u.output_tokens)! } : {}), raw: rec }];
    }
    case 'stream_error':
      return [{ t, kind: 'warning', code: 'stream_error', message: str(msg.message) ?? 'stream error', raw: rec }];
    case 'error':
      return classifyStreamNoise(str(msg.message) ?? 'error', rec, t);
    default:
      return [];
  }
}

/** "…or try again at Jan 2nd, 2030 9:05 AM." → ISO time, in the operator's local zone as Codex prints it. */
export function parseRetryAt(message: string): string | undefined {
  const m = /try again (?:at|on) ([^.]+?\d{4}[^.]*?(?:AM|PM)?)\.?\s*$/i.exec(message.trim());
  if (!m?.[1]) return undefined;
  const when = new Date(m[1].replace(/(\d+)(st|nd|rd|th)\b/i, '$1'));
  return Number.isNaN(when.getTime()) ? undefined : when.toISOString();
}

/** Failing to start one of the OPERATOR's MCP servers is noise, not a failed run. */
function classifyStreamNoise(message: string, rec: Json, t: string): WorkerEvent[] {
  if (/^MCP client for /i.test(message)) return [{ t, kind: 'warning', code: 'mcp_start_failed', message, raw: rec }];
  const out: WorkerEvent[] = [{ t, kind: 'error', code: 'error', message, raw: rec }];
  // Codex has no quota telemetry; the limit message is the only signal, so make it a first-class one.
  if (/usage limit/i.test(message)) {
    const resets_at = parseRetryAt(message);
    out.push({ t, kind: 'rate_limit', status: 'rejected', ...(resets_at ? { resets_at } : {}), raw: rec });
  }
  return out;
}

const MODEL = /requires a newer version of codex|model is not supported|not supported when using codex|model[^\n]{0,60}(?:not found|does not exist|not available)|unknown model|invalid model/i;
const CONFIG = /unknown variant|failed to deserialize|error (?:loading|parsing) config|config\.toml|invalid (?:config|override)|unknown field/i;
const USAGE = /unexpected argument|unrecognized (?:option|subcommand)|a value is required|invalid value .* for|usage: codex/i;
const RATE = /usage limit|rate.?limit|too many requests|\b429\b|quota|try again (?:in|at)/i;
const AUTH = /\b401\b|unauthorized|not logged in|codex login|token (?:is )?expired|refresh token|authentication/i;

export const codexDriver: VendorDriver = {
  parseStdoutLine: parseCodexLine,

  /**
   * `codex exec` exits 0 after an unrecoverable API error (observed on 0.36
   * and documented in docs/13-environment-findings.md), so the event stream
   * decides and the exit code only corroborates.
   */
  classify({ exit_code, spawn_error, events, stderr, final_text }) {
    if (spawn_error) return { classification: 'crashed', detail: `could not start codex: ${spawn_error}` };
    const errors = events.filter((e): e is Extract<WorkerEvent, { kind: 'error' }> => e.kind === 'error');
    // An error followed by a completed turn was recovered from.
    const lastError = events.findLastIndex((e) => e.kind === 'error');
    const lastAnswer = events.findLastIndex((e) => e.kind === 'assistant_text' || e.kind === 'usage');
    const failed = errors.length > 0 && lastError > lastAnswer;
    if (exit_code === 0 && !failed) return { classification: 'ok' };

    const text = [...errors.map((e) => e.message), stderr].join('\n');
    const detail = (errors[errors.length - 1]?.message ?? stderr.trim().split('\n').slice(-3).join(' ')).slice(0, 500) || undefined;
    const as = (classification: Classification): { classification: Classification; detail?: string } => ({ classification, ...(detail ? { detail } : {}) });
    if (MODEL.test(text)) return as('model_rejected');
    if (CONFIG.test(text)) return as('config_rejected');
    if (exit_code === 2 && USAGE.test(stderr)) return as('cli_usage_error');
    if (RATE.test(text)) return as('rate_limited');
    if (AUTH.test(text)) return as('auth_failed');
    if (failed) return as('vendor_error');
    return { classification: 'crashed', detail: detail ?? `codex exited ${exit_code}${final_text ? '' : ' without an answer'}` };
  },
};

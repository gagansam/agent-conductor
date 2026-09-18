import { tryParseJson, type Classification, type VendorDriver, type WorkerEvent } from '@agent-conductor/adapter-api';

type Json = Record<string, unknown>;
const obj = (x: unknown): Json | undefined => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Json) : undefined);
const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const clip = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const FILE_TOOLS: Record<string, 'create' | 'modify'> = { Write: 'create', Edit: 'modify', MultiEdit: 'modify', NotebookEdit: 'modify' };

function summarizeToolInput(tool: string, input: Json | undefined): string {
  if (!input) return tool;
  const hint = str(input.command) ?? str(input.file_path) ?? str(input.path) ?? str(input.pattern) ?? str(input.url) ?? str(input.description);
  return hint ? `${tool}: ${clip(hint.replace(/\s+/g, ' '))}` : tool;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => str(obj(c)?.text) ?? '').join('\n');
  return '';
}

/** `claude -p --output-format stream-json --verbose`, as observed on 2.1.x. Unknown records are ignored, never fatal. */
export function parseClaudeLine(line: string, now: () => string): WorkerEvent[] {
  const rec = obj(tryParseJson(line));
  if (!rec) return [];
  const t = now();
  const type = str(rec.type);

  if (type === 'system' && rec.subtype === 'init') {
    const session_ref = str(rec.session_id);
    const model_id = str(rec.model);
    return [{ t, kind: 'started', ...(session_ref ? { session_ref } : {}), ...(model_id ? { model_id } : {}), raw: rec }];
  }

  if (type === 'assistant') {
    // Sub-agent chatter is not the worker's own voice.
    if (rec.parent_tool_use_id) return [];
    const out: WorkerEvent[] = [];
    const content = obj(rec.message)?.content;
    for (const block of Array.isArray(content) ? content : []) {
      const b = obj(block);
      if (!b) continue;
      if (b.type === 'text' && str(b.text)) out.push({ t, kind: 'assistant_text', text: str(b.text)!, partial: false, raw: rec });
      if (b.type === 'tool_use') {
        const tool = str(b.name) ?? 'tool';
        const input = obj(b.input);
        const id = str(b.id);
        out.push({ t, kind: 'tool_call', ...(id ? { id } : {}), tool, summary: summarizeToolInput(tool, input), raw: rec });
        const op = FILE_TOOLS[tool];
        const path = str(input?.file_path) ?? str(input?.notebook_path);
        if (op && path) out.push({ t, kind: 'file_change', path, op, raw: rec });
      }
    }
    return out;
  }

  if (type === 'user') {
    const out: WorkerEvent[] = [];
    const content = obj(rec.message)?.content;
    for (const block of Array.isArray(content) ? content : []) {
      const b = obj(block);
      if (b?.type !== 'tool_result') continue;
      const id = str(b.tool_use_id);
      out.push({ t, kind: 'tool_result', ...(id ? { id } : {}), ok: b.is_error !== true, summary: clip(toolResultText(b.content).replace(/\s+/g, ' ')), raw: rec });
    }
    return out;
  }

  if (type === 'rate_limit_event') {
    const info = obj(rec.rate_limit_info);
    const status = str(info?.status);
    const windows = obj(info?.unifiedWindows);
    const out: WorkerEvent[] = [];
    for (const [window, w] of Object.entries(windows ?? {})) {
      const o = obj(w);
      const utilization = num(o?.utilization);
      const resets = num(o?.resetsAt);
      out.push({
        t,
        kind: 'rate_limit',
        window,
        ...(utilization !== undefined ? { utilization } : {}),
        ...(resets !== undefined ? { resets_at: new Date(resets * 1000).toISOString() } : {}),
        ...(status ? { status } : {}),
        raw: rec,
      });
    }
    if (!out.length) out.push({ t, kind: 'rate_limit', ...(status ? { status } : {}), raw: rec });
    return out;
  }

  if (type === 'result') {
    const out: WorkerEvent[] = [];
    const usage = obj(rec.usage);
    const input = (num(usage?.input_tokens) ?? 0) + (num(usage?.cache_creation_input_tokens) ?? 0);
    const cached = num(usage?.cache_read_input_tokens);
    const cost = num(rec.total_cost_usd);
    out.push({ t, kind: 'usage', input_tokens: input, ...(cached !== undefined ? { cached_input_tokens: cached } : {}), ...(num(usage?.output_tokens) !== undefined ? { output_tokens: num(usage?.output_tokens)! } : {}), ...(cost !== undefined ? { cost_usd: cost } : {}), raw: rec });
    if (rec.is_error === true || (str(rec.subtype) ?? 'success') !== 'success') {
      out.push({ t, kind: 'error', code: str(rec.subtype) ?? 'error', message: clip(str(rec.result) ?? str(rec.error) ?? 'the run ended with an error', 2000), raw: rec });
    }
    return out;
  }
  return [];
}

const RATE = /usage limit|rate.?limit|limit (?:will )?reset|too many requests|\b429\b|overloaded/i;
const AUTH = /invalid api key|not logged in|please run \/login|authentication[_ ]error|\b401\b|oauth token|unauthorized/i;
const MODEL = /model[^\n]{0,80}(?:not found|not supported|does not exist|not available|invalid)|invalid model|\b404\b[^\n]{0,40}model/i;
const USAGE = /unknown option|unknown argument|missing required argument|error: option|too many arguments|invalid choice|argument .* is invalid/i;
const CONFIG = /settings?(?:\.json)?[^\n]{0,60}(?:invalid|parse|malformed)|invalid settings|failed to parse/i;

export const claudeDriver: VendorDriver = {
  parseStdoutLine: parseClaudeLine,

  /** Never exit code alone: a usage-limit message arrives as a normal-looking result with is_error. */
  classify({ exit_code, spawn_error, events, stderr, final_text }) {
    if (spawn_error) return { classification: 'crashed', detail: `could not start claude: ${spawn_error}` };
    const errors = events.filter((e): e is Extract<WorkerEvent, { kind: 'error' }> => e.kind === 'error');
    const rejected = events.some((e) => e.kind === 'rate_limit' && e.status !== undefined && /reject|exceed|block/i.test(e.status));
    const text = [...errors.map((e) => e.message), stderr, errors.length || exit_code !== 0 ? final_text : ''].join('\n');
    const detail = (errors[0]?.message ?? stderr.trim().split('\n').slice(-3).join(' ')).slice(0, 500) || undefined;
    const as = (classification: Classification): { classification: Classification; detail?: string } => ({ classification, ...(detail ? { detail } : {}) });

    if (exit_code !== 0 || errors.length) {
      if (rejected || RATE.test(text)) return as('rate_limited');
      if (AUTH.test(text)) return as('auth_failed');
      if (MODEL.test(text)) return as('model_rejected');
      if (USAGE.test(stderr)) return as('cli_usage_error');
      if (CONFIG.test(stderr)) return as('config_rejected');
      if (errors.length) return as('vendor_error');
      return as('crashed');
    }
    return { classification: 'ok' };
  },
};

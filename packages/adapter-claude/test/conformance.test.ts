import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatResults, runOfflineConformance } from '@agent-conductor/adapter-api/conformance';
import { claudeDriver, createAdapter, parseClaudeLine, toBashRule } from '../src/index.js';

describe('claude adapter', () => {
  it('passes offline conformance on every recorded version', async () => {
    const results = await runOfflineConformance({
      createAdapter: (spawn) => createAdapter({ spawn }),
      fixturesDir: fileURLToPath(new URL('../fixtures/', import.meta.url)),
      detection: (version, help, vendorHome) => ({ binary_abs: '/nonexistent/claude', version, binary_mtime_ms: 0, auth: 'unknown', problems: [], vendor_home: vendorHome, ...(help ? { help_text: help } : {}) }),
      operatorHome: join(homedir(), '.claude'),
      isWriteEnabling: (argv) => argv.some((a) => /acceptEdits|bypassPermissions|dangerously-skip-permissions/.test(a)),
      // Deny rules are always written to the conductor's settings file; with optional flags on they are in argv too.
      denyEnforcement: (argv, pattern) => (argv.some((a) => a.includes(toBashRule(pattern))) ? 'argv' : 'documented'),
    });
    const failed = results.filter((r) => !r.ok);
    expect(failed, formatResults(failed)).toEqual([]);
    expect(results.length).toBeGreaterThan(20);
  });

  it('translates command patterns into permission rules', () => {
    expect(toBashRule('pnpm test*')).toBe('Bash(pnpm test:*)');
    expect(toBashRule('git commit*')).toBe('Bash(git commit:*)');
    expect(toBashRule('pwd')).toBe('Bash(pwd)');
  });

  it('emits one rate_limit event per quota window', () => {
    const line = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.23, resetsAt: 1788724200 }, seven_day: { utilization: 0.2, resetsAt: 1789099200 } } } });
    const ev = parseClaudeLine(line, () => 't');
    expect(ev.map((e) => (e.kind === 'rate_limit' ? [e.window, e.utilization] : []))).toEqual([['five_hour', 0.23], ['seven_day', 0.2]]);
  });

  it('classifies a usage-limit result as rate_limited even though the process exits 0', () => {
    const events = parseClaudeLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude usage limit reached. Your limit will reset at 3pm.', usage: {} }), () => 't');
    expect(claudeDriver.classify({ exit_code: 0, signal: null, events, stderr: '', final_text: '' }).classification).toBe('rate_limited');
  });

  it('ignores sub-agent chatter and unknown records', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: 'sub' }] } }), () => 't')).toEqual([]);
    expect(parseClaudeLine('{"type":"brand_new_event"}', () => 't')).toEqual([]);
  });
});

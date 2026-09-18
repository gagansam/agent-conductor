import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatResults, runOfflineConformance } from '@agent-conductor/adapter-api/conformance';
import { sampleJob } from '@agent-conductor/adapter-api/conformance';
import { buildCodexArgv, codexDriver, createAdapter, parseCodexLine } from '../src/index.js';
import { parseRetryAt } from '../src/events.js';

describe('codex adapter', () => {
  it('passes offline conformance on every recorded version', async () => {
    const results = await runOfflineConformance({
      createAdapter: (spawn) => createAdapter({ spawn }),
      fixturesDir: fileURLToPath(new URL('../fixtures/', import.meta.url)),
      detection: (version, help, vendorHome) => ({ binary_abs: '/nonexistent/codex', version, binary_mtime_ms: 0, auth: 'ok', problems: [], vendor_home: vendorHome, ...(help ? { help_text: help } : {}) }),
      operatorHome: join(homedir(), '.codex'),
      isWriteEnabling: (argv) => argv.some((a) => /workspace-write|danger-full-access|dangerously-bypass/.test(a)),
      // Codex cannot filter commands. Refusing hooks plus the post-run audit carry this (docs/09).
      denyEnforcement: () => 'documented',
    });
    const failed = results.filter((r) => !r.ok);
    expect(failed, formatResults(failed)).toEqual([]);
    expect(results.length).toBeGreaterThan(30);
  });

  it('puts every flag before `resume`, because 0.3x `exec resume` accepts almost none', async () => {
    const caps = await createAdapter().capabilities({ binary_abs: 'x', version: '0', binary_mtime_ms: 0, auth: 'ok', problems: [], vendor_home: '/v', help_text: 'resume --model --ignore-user-config' });
    const { argv } = buildCodexArgv(sampleJob('/cwd', '/logs', { resume: { session_ref: 'SID' } }), caps, '--ignore-user-config --model', {});
    const at = argv.indexOf('resume');
    expect(argv.slice(at)).toEqual(['resume', 'SID', '-']);
    expect(argv.slice(0, at)).toEqual(expect.arrayContaining(['exec', '--json', '-m', 'conformance-model', '--ignore-user-config']));
    expect(argv).not.toContain('-s');
  });

  it('reads both JSONL dialects', () => {
    const now = (): string => '2026-01-01T00:00:00.000Z';
    expect(parseCodexLine('{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"hi"}}', now)[0]).toMatchObject({ kind: 'assistant_text', text: 'hi' });
    expect(parseCodexLine('{"id":"0","msg":{"type":"agent_message","message":"hi"}}', now)[0]).toMatchObject({ kind: 'assistant_text', text: 'hi' });
    expect(parseCodexLine('{"type":"item.completed","item":{"id":"i","type":"file_change","changes":[{"path":"a.ts","kind":"add"}]}}', now)[0]).toMatchObject({ kind: 'file_change', path: 'a.ts', op: 'create' });
    expect(parseCodexLine('not json', now)).toEqual([]);
    expect(parseCodexLine('{"type":"something.new"}', now)).toEqual([]);
  });

  it("treats the operator's failing MCP servers as noise", () => {
    const ev = parseCodexLine('{"id":"","msg":{"type":"error","message":"MCP client for `computer-use` failed to start: No such file"}}', () => 't');
    expect(ev.map((e) => e.kind)).toEqual(['warning']);
  });

  it('turns the usage-limit message into a rate_limit signal with a reset time', () => {
    const msg = "You've hit your usage limit. Upgrade to Pro, or try again at Jan 2nd, 2030 9:05 AM.";
    expect(parseRetryAt(msg)).toBe(new Date('Jan 2, 2030 9:05 AM').toISOString());
    expect(parseRetryAt('some other error')).toBeUndefined();
    const ev = parseCodexLine(JSON.stringify({ type: 'error', message: msg }), () => 't');
    expect(ev.map((e) => e.kind)).toEqual(['error', 'rate_limit']);
  });

  it('classifies a failed turn from the stream, whether codex exits 1 (0.1xx) or 0 (0.3x)', () => {
    const msg = "You've hit your usage limit. Try again at Jan 2nd, 2030 9:05 AM.";
    const events = [
      ...parseCodexLine('{"type":"thread.started","thread_id":"00000000-0000-0000-0000-000000000000"}', () => 't'),
      ...parseCodexLine(JSON.stringify({ type: 'error', message: msg }), () => 't'),
      ...parseCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: msg } }), () => 't'),
    ];
    for (const exit_code of [1, 0]) {
      expect(codexDriver.classify({ exit_code, signal: null, events, stderr: '', final_text: '' }).classification).toBe('rate_limited');
    }
  });
});

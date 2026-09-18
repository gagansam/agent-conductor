import { XMLParser } from 'fast-xml-parser';
import type { ParsedFailure } from '../contracts/verification.js';

const MAX_MESSAGE = 2048;
const clip = (s: string): string => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s);
const asArray = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

interface JunitCase {
  '@_name'?: string;
  '@_classname'?: string;
  '@_file'?: string;
  '@_line'?: string;
  failure?: unknown;
  error?: unknown;
}
interface JunitSuite {
  '@_file'?: string;
  testcase?: JunitCase | JunitCase[];
  testsuite?: JunitSuite | JunitSuite[];
}

function nodeText(n: unknown): string {
  if (typeof n === 'string') return n;
  if (n && typeof n === 'object') {
    const o = n as Record<string, unknown>;
    return [o['@_message'], o['#text']].filter((x): x is string => typeof x === 'string').join('\n');
  }
  return '';
}

/** JUnit XML as written by vitest, jest-junit, pytest, playwright. Returns null when it is not parseable. */
export function parseJunit(xml: string): ParsedFailure[] | null {
  if (!xml.trim()) return null;
  let doc: { testsuites?: JunitSuite; testsuite?: JunitSuite | JunitSuite[] };
  try {
    doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false }).parse(xml);
  } catch {
    return null;
  }
  const roots = doc.testsuites ? asArray(doc.testsuites.testsuite) : asArray(doc.testsuite);
  if (!doc.testsuites && !doc.testsuite) return null;
  const failures: ParsedFailure[] = [];
  const walk = (suite: JunitSuite): void => {
    for (const tc of asArray(suite.testcase)) {
      for (const f of [...asArray(tc.failure), ...asArray(tc.error)]) {
        const file = tc['@_file'] ?? suite['@_file'];
        const line = tc['@_line'] ? Number(tc['@_line']) : undefined;
        failures.push({
          name: [tc['@_classname'], tc['@_name']].filter(Boolean).join(' › ') || '(unnamed test)',
          ...(file ? { file } : {}),
          ...(line !== undefined && Number.isFinite(line) ? { line } : {}),
          message: clip(nodeText(f)),
        });
      }
    }
    for (const s of asArray(suite.testsuite)) walk(s);
  };
  roots.forEach(walk);
  return failures;
}

/** `src/a.ts(12,5): error TS2322: message` and the `src/a.ts:12:5 - error TS2322: message` pretty form. */
export function parseTsc(output: string): ParsedFailure[] {
  const failures: ParsedFailure[] = [];
  const re = /^(.+?)(?:\((\d+),\d+\)|:(\d+):\d+)\s*(?::|-)\s*error\s+(TS\d+):\s*(.*)$/;
  for (const raw of output.split('\n')) {
    const m = re.exec(raw.trim());
    if (m) failures.push({ name: m[4]!, file: m[1]!, line: Number(m[2] ?? m[3]), message: clip(m[5] ?? '') });
  }
  return failures;
}

interface EslintFile {
  filePath: string;
  messages: { ruleId: string | null; severity: number; message: string; line?: number }[];
}

/** `eslint -f json`. Only errors (severity 2) count as failures. */
export function parseEslintJson(json: string): ParsedFailure[] | null {
  let doc: EslintFile[];
  try {
    doc = JSON.parse(json) as EslintFile[];
  } catch {
    return null;
  }
  if (!Array.isArray(doc)) return null;
  return doc.flatMap((f) =>
    f.messages
      .filter((m) => m.severity === 2)
      .map((m) => ({ name: m.ruleId ?? 'eslint', file: f.filePath, ...(m.line ? { line: m.line } : {}), message: clip(m.message) })),
  );
}

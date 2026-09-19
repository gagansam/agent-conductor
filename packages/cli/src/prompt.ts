import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { c } from './print.js';

/**
 * Terminal questions with defaults. Outside a terminal, or with --yes, every
 * question takes its default without asking, so scripted use never hangs.
 */
export class Prompter {
  readonly interactive: boolean;
  private rl: Interface | undefined;
  private closed = false;

  constructor(
    yes: boolean,
    private readonly opts: { onInterrupt?: () => void } = {},
  ) {
    this.interactive = !yes && process.stdin.isTTY === true && process.stdout.isTTY === true;
  }

  /**
   * Enter accepts `def`. `validate` returns an error message, or undefined when the answer is fine.
   * Aborting `signal` (a timeout) gives up on this question with `def` and keeps prompting for later ones.
   */
  async ask(question: string, def: string, validate?: (answer: string) => string | undefined, signal?: AbortSignal): Promise<string> {
    if (!this.interactive || this.closed || signal?.aborted) return def;
    this.rl ??= this.open();
    for (;;) {
      let answer: string;
      try {
        answer = (await this.rl.question(`${question}${def ? c.dim(` [${def}]`) : ''}: `, signal ? { signal } : {})).trim();
      } catch {
        if (signal?.aborted) {
          process.stdout.write('\n');
          return def;
        }
        // Ctrl-D: stop asking, take defaults from here on.
        this.closed = true;
        process.stdout.write('\n');
        return def;
      }
      const value = answer === '' ? def : answer;
      const error = validate?.(value);
      if (!error) return value;
      process.stdout.write(`  ${c.red(error)}\n`);
    }
  }

  async confirm(question: string, def: boolean): Promise<boolean> {
    const a = await this.ask(`${question} ${c.dim(def ? '[Y/n]' : '[y/N]')}`, '', (v) => (/^(y|yes|n|no|)$/i.test(v) ? undefined : 'answer y or n'));
    return a === '' ? def : /^y/i.test(a);
  }

  /** Open $VISUAL / $EDITOR on `initial` and return what was saved. The prompt resumes afterwards. */
  editText(initial: string): string {
    this.rl?.close();
    this.rl = undefined;
    const file = join(tmpdir(), `conductor-${process.pid}-${Date.now()}.md`);
    writeFileSync(file, initial);
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    spawnSync(`${editor} "${file}"`, { stdio: 'inherit', shell: true });
    const text = readFileSync(file, 'utf8');
    rmSync(file, { force: true });
    return text.trim();
  }

  close(): void {
    this.rl?.close();
    this.rl = undefined;
  }

  private open(): Interface {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // readline swallows Ctrl-C by default. Without a handler, quit; with one, hand it over and stop asking,
    // so a pending question resolves to its default instead of hanging.
    rl.on('SIGINT', () => {
      process.stdout.write('\n');
      if (!this.opts.onInterrupt) process.exit(130);
      this.opts.onInterrupt();
      this.closed = true;
      rl.close();
    });
    return rl;
  }
}

/** "a, b,c" → ["a", "b", "c"]; "-" or "" → []. */
export const splitList = (v: string): string[] => (v.trim() === '-' ? [] : v.split(',').map((s) => s.trim()).filter(Boolean));

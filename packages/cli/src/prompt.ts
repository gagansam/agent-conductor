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

  constructor(yes: boolean) {
    this.interactive = !yes && process.stdin.isTTY === true && process.stdout.isTTY === true;
  }

  /** Enter accepts `def`. `validate` returns an error message, or undefined when the answer is fine. */
  async ask(question: string, def: string, validate?: (answer: string) => string | undefined): Promise<string> {
    if (!this.interactive || this.closed) return def;
    this.rl ??= this.open();
    for (;;) {
      let answer: string;
      try {
        answer = (await this.rl.question(`${question}${def ? c.dim(` [${def}]`) : ''}: `)).trim();
      } catch {
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

  close(): void {
    this.rl?.close();
  }

  private open(): Interface {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // readline swallows Ctrl-C by default; make it quit like everywhere else.
    rl.on('SIGINT', () => {
      process.stdout.write('\n');
      process.exit(130);
    });
    return rl;
  }
}

/** "a, b,c" → ["a", "b", "c"]; "-" or "" → []. */
export const splitList = (v: string): string[] => (v.trim() === '-' ? [] : v.split(',').map((s) => s.trim()).filter(Boolean));

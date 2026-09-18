import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { applyPatch, checkPatch, git, type RunSummary } from '@agent-conductor/core';
import { openContext } from '../context.js';
import { c } from '../print.js';

export interface ApplyFlags {
  threeWay: boolean;
  force: boolean;
}

const out = (s = ''): void => void process.stdout.write(`${s}\n`);
const fail = (s: string): number => {
  process.stderr.write(`${c.red('refused')}: ${s}\n`);
  return 1;
};

/**
 * The only code path that writes to the operator's checkout (ADR-0008). It
 * applies the patch to the working tree and stops: nothing is staged, nothing
 * is committed, no ref moves.
 */
export async function apply(ref: string | undefined, flags: ApplyFlags): Promise<number> {
  const ctx = openContext();
  try {
    const run = ref ? ctx.store.findRun(ref) : ctx.store.latestRun();
    if (!run) return fail(ref ? `no run matches "${ref}"` : 'no runs yet');
    const task = ctx.store.getTask(run.task_id);
    if (!task) return fail('the run has no task row');
    if (!run.patch_path || !existsSync(run.patch_path)) return fail('this run produced no patch');
    if (statSync(run.patch_path).size === 0) return fail('the patch is empty');
    if (run.applied_at && !flags.force) return fail(`already applied at ${run.applied_at} (use --force to apply again)`);
    if (run.status !== 'done' && !flags.force) {
      return fail(`run is "${run.status}"${run.escalation_reason ? ` (${run.escalation_reason})` : ''}, not converged. Inspect it with \`conductor show ${run.id.slice(-6)}\`; use --force to apply anyway.`);
    }

    const repo = task.repo_path;
    const summaryFile = join(run.run_dir, 'summary.json');
    const summary = existsSync(summaryFile) ? (JSON.parse(readFileSync(summaryFile, 'utf8')) as RunSummary) : undefined;
    const patchFiles = new Set(summary?.patch?.files_changed ?? []);

    // Your in-flight edits are yours. Only edits to the same files block the apply.
    const status = (await git(repo, ['status', '--porcelain', '-z'])).stdout.split('\0').filter(Boolean);
    const dirty = status.map((l) => l.slice(3));
    const overlap = dirty.filter((f) => patchFiles.has(f));
    if (overlap.length && !flags.force) return fail(`your checkout has uncommitted changes to files this patch touches:\n  ${overlap.join('\n  ')}\nCommit or move them first, or use --force.`);

    const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    if (head !== task.base_sha && !flags.threeWay) {
      const probe = await checkPatch(repo, run.patch_path);
      if (!probe.ok) return fail(`HEAD is ${head.slice(0, 10)} but the run started from ${task.base_sha.slice(0, 10)}, and the patch no longer applies:\n${probe.detail}\nRe-run with --3way to apply with conflict markers.`);
      out(c.yellow(`note: HEAD moved since the run started (${task.base_sha.slice(0, 10)} → ${head.slice(0, 10)}); the patch still applies as is.`));
    }

    try {
      await applyPatch(repo, run.patch_path, { threeWay: flags.threeWay });
    } catch (e) {
      return fail(`${(e as Error).message}\n${flags.threeWay ? 'Resolve the conflict markers by hand.' : 'Try --3way.'}`);
    }
    ctx.store.updateRun(run.id, { applied_at: new Date().toISOString(), applied_to_sha: head });

    out(`${c.green('applied')} ${patchFiles.size || 'the'} file(s) to ${repo}`);
    out(c.dim('Nothing was staged or committed. Review with your usual diff tooling, then commit yourself.'));
    if (summary?.open_repro_files.length) out(c.yellow(`Left out on purpose (failing reproductions of open findings): ${summary.open_repro_files.join(', ')}\n  They are in ${summary.worktree}`));
    return 0;
  } finally {
    ctx.store.close();
  }
}

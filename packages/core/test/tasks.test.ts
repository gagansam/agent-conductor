import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeAdapter } from '@agent-conductor/adapter-fake';
import { pathsFor, resolveRoles } from '../src/config/load.js';
import { childRepos, lookupRepoRef, registerRepo } from '../src/config/repos.js';
import { GlobalConfigSchema, RepoConfigSchema } from '../src/config/schema.js';
import { draftTask } from '../src/draft/draft.js';
import { Store } from '../src/store/store.js';
import { findSavedTask, listSavedTasks, renderTaskFile, savedTaskPath, sentenceTask, slugify, taskRepoHint, writeTaskFile } from '../src/task/files.js';
import { parseTask } from '../src/task/parse.js';
import { makeTempRepo, type TempRepo } from './helpers/repo.js';

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.dispose();
  repo = undefined;
});

const global = GlobalConfigSchema.parse({
  version: 1,
  providers: { alpha: { adapter: 'fake', models: { strong: 'alpha-1' } } },
  roles: { implementer: { provider: 'alpha', model: 'strong', effort: 'high' } },
});

describe('task files', () => {
  it('writes a task that parses back, including its repo and checks', () => {
    const text = renderTaskFile({
      title: 'Migrate GET /projects/{id}',
      kind: 'feature',
      repo: 'fieldscope-platform-api',
      description: 'Port the route.\n\nMatch the Next.js behaviour: "404" for others\' projects.',
      acceptance: [
        { id: 'AC1', text: 'Returns the project', check: { kind: 'command', run: 'uv run pytest -q tests/test_projects.py -k "get and not missing"', expect_exit: 0 } },
        { id: 'AC2', text: 'Returns 404: for missing projects' },
      ],
      constraints: ['No new dependencies'],
      touch_hint: ['fs_api/**'],
      context_files: ['/abs/route.ts'],
    });
    expect(taskRepoHint(text)).toBe('fieldscope-platform-api');
    const t = parseTask(text, { repo_abs: '/r', global });
    expect(t.title).toBe('Migrate GET /projects/{id}');
    expect(t.acceptance[0]!.check).toEqual({ kind: 'command', run: 'uv run pytest -q tests/test_projects.py -k "get and not missing"', expect_exit: 0 });
    expect(t.acceptance[1]).toEqual({ id: 'AC2', text: 'Returns 404: for missing projects' });
    expect(t.description).toContain('"404" for others\' projects');
    expect([t.constraints, t.touch_hint, t.context_files]).toEqual([['No new dependencies'], ['fs_api/**'], ['/abs/route.ts']]);
  });

  it('turns a sentence into a runnable task', () => {
    const t = parseTask(sentenceTask('Add divide(a, b) to lib/math.js: throw on zero'), { repo_abs: '/r', global });
    expect(t.title).toBe('Add divide(a, b) to lib/math.js: throw on zero');
    expect(t.acceptance).toEqual([{ id: 'AC1', text: 'Add divide(a, b) to lib/math.js: throw on zero' }]);
    expect(taskRepoHint(sentenceTask('x y'))).toBeUndefined();
  });

  it('saves under the repo name, never overwriting, and finds tasks by name with or without the date', () => {
    repo = makeTempRepo();
    const paths = pathsFor(join(repo.scratch, 'home'));
    const day = new Date('2026-09-19T10:00:00Z');
    const a = savedTaskPath(paths, 'api', 'Migrate GET /projects/{id}!', day);
    expect(a.endsWith('tasks/api/2026-09-19-migrate-get-projects-id.md')).toBe(true);
    writeTaskFile(a, sentenceTask('first one'));
    const b = savedTaskPath(paths, 'api', 'Migrate GET /projects/{id}!', day);
    expect(b.endsWith('2026-09-19-migrate-get-projects-id-2.md')).toBe(true);
    writeTaskFile(b, sentenceTask('second one'));
    writeTaskFile(savedTaskPath(paths, 'web', 'Fix login', day), sentenceTask('fix the login'));

    expect(findSavedTask(paths, '2026-09-19-fix-login')?.repo).toBe('web');
    expect(findSavedTask(paths, 'fix-login')?.title).toBe('fix the login');
    expect(findSavedTask(paths, 'migrate-get-projects-id')?.name).toBe('2026-09-19-migrate-get-projects-id');
    writeTaskFile(savedTaskPath(paths, 'web', 'Migrate GET /projects/{id}', day), sentenceTask('the web side'));
    expect(() => findSavedTask(paths, 'migrate-get-projects-id')).toThrow(/matches 2 saved tasks: .*api.*web|matches 2 saved tasks: .*web.*api/);
    expect(findSavedTask(paths, 'nope')).toBeUndefined();
    expect(listSavedTasks(paths, 'api').map((t) => t.name).sort()).toEqual(['2026-09-19-migrate-get-projects-id', '2026-09-19-migrate-get-projects-id-2']);
    expect(slugify('   ')).toBe('task');
    expect(slugify('Add a zero-safe divide helper next to existing arithmetic helpers')).toBe('add-a-zero-safe-divide-helper-next-to-existing');
  });
});

describe('repo registry', () => {
  it('remembers repos by folder name, resolves names and paths, and finds repos in a workspace folder', () => {
    repo = makeTempRepo();
    const paths = pathsFor(join(repo.scratch, 'home'));
    expect(registerRepo(paths, repo.root)).toBe('repo');
    expect(registerRepo(paths, repo.root)).toBe('repo');
    const other = join(repo.scratch, 'elsewhere', 'repo');
    mkdirSync(other, { recursive: true });
    expect(registerRepo(paths, other)).toBe('elsewhere-repo');
    expect(lookupRepoRef(paths, 'repo', '/anywhere')).toBe(repo.root);
    expect(lookupRepoRef(paths, '../repo', join(repo.scratch))).toBe(repo.root);
    expect(lookupRepoRef(paths, 'missing', '/anywhere')).toBeUndefined();
    expect(childRepos(dirname(repo.root))).toEqual([repo.root]);
  });
});

describe('draftTask', () => {
  const DRAFT = {
    schema_version: 1,
    title: 'Add divide',
    description: 'Add divide(a, b) next to sum.',
    acceptance: [{ id: 'AC1', text: 'divide works', check: { kind: 'command', run: 'node --test test/math.test.js' } }],
    touch_hint: ['lib/math.js'],
    context_files: [],
    notes: 'Division by zero is unspecified.',
  };

  const setup = () => {
    repo = makeTempRepo({ 'lib/math.js': 'module.exports.sum = (a, b) => a + b;\n', 'AGENTS.md': '# Rules\n\nKeep it small.\n' });
    const paths = pathsFor(join(repo.scratch, 'home'));
    const store = Store.open(':memory:');
    const target = resolveRoles(global, RepoConfigSchema.parse({ version: 1 }), {}).implementer;
    return { paths, store, target };
  };

  it('drafts read-only in a throwaway worktree and cleans up', async () => {
    const { paths, store, target } = setup();
    const fake = createFakeAdapter({
      script: (job) => ({ final_text: JSON.stringify({ ...DRAFT, context_files: [`${job.cwd_abs}/lib/math.js`] }) }),
    });
    const res = await draftTask({ repo_abs: repo!.root, request: 'add a divide function', target, global, adapters: { alpha: fake }, store, paths, related_repos_abs: ['/other/repo'] });
    expect(res.classification).toBe('ok');
    expect(res.draft?.title).toBe('Add divide');
    expect(res.draft?.acceptance[0]?.check).toEqual({ kind: 'command', run: 'node --test test/math.test.js', expect_exit: 0 });
    // Paths inside the throwaway worktree come back as paths inside the repo.
    expect(res.draft?.context_files).toEqual(['lib/math.js']);

    const job = fake.jobs[0]!;
    expect(job.policy.fs).toBe('read-only');
    expect(job.policy.extra_readable_dirs_abs).toEqual(['/other/repo']);
    expect(job.policy.denied_commands).toContain('git commit*');
    expect(job.model_id).toBe('alpha-1');
    expect(job.prompt).toContain('add a divide function');
    expect(existsSync(job.cwd_abs)).toBe(false);
    expect(readdirSync(join(paths.home, 'drafts'))).toHaveLength(1);
    store.close();
  });

  it('repairs an invalid draft once, in the same session', async () => {
    const { paths, store, target } = setup();
    const fake = createFakeAdapter({ script: (_job, i) => ({ final_text: i === 0 ? 'Here is my plan: …' : JSON.stringify(DRAFT) }) });
    const res = await draftTask({ repo_abs: repo!.root, request: 'add divide', target, global, adapters: { alpha: fake }, store, paths });
    expect(res.draft?.title).toBe('Add divide');
    expect(fake.jobs[1]!.resume?.session_ref).toBe('fake-session-1');
    expect(fake.jobs[1]!.prompt).toContain('Reply now with only the corrected JSON document');
    store.close();
  });

  it('reports a failed draft without throwing', async () => {
    const { paths, store, target } = setup();
    const fake = createFakeAdapter({ script: () => ({ classification: 'rate_limited' }) });
    const res = await draftTask({ repo_abs: repo!.root, request: 'add divide', target, global, adapters: { alpha: fake }, store, paths });
    expect(res.draft).toBeUndefined();
    expect(res.classification).toBe('rate_limited');
    store.close();
  });
});


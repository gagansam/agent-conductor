import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { allowedCommandsFor, commandPattern, detectRepo, renderRepoConfig, type RepoDetection } from '../src/config/detect.js';
import { RepoConfigSchema } from '../src/config/schema.js';
import { makeTempRepo, type TempRepo } from './helpers/repo.js';

let repo: TempRepo | undefined;
afterEach(() => repo?.dispose());

const detect = async (files: Record<string, string>): Promise<RepoDetection> => {
  repo = makeTempRepo(files);
  return detectRepo(repo.root);
};
/** What a run would load: the rendered file, through the real schema. */
const roundTrip = (d: RepoDetection) => RepoConfigSchema.parse(parseYaml(renderRepoConfig(d)));
const pkg = (o: object): string => JSON.stringify(o);

describe('detectRepo', () => {
  it('reads a pnpm repo: scripts, test dirs, instructions, skills', async () => {
    const d = await detect({
      'package.json': pkg({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest' }, devDependencies: { vitest: '5', typescript: '7' } }),
      'pnpm-lock.yaml': '',
      'tests/a.test.ts': '',
      'AGENTS.md': '# rules',
      '.claude/skills/expert-review/SKILL.md': '# review',
    });
    expect(d.stacks).toEqual(['node (pnpm)']);
    expect(d.setup?.run).toBe('pnpm install --frozen-lockfile --prefer-offline');
    expect(d.steps.map((s) => [s.id, s.run])).toEqual([['typecheck', 'pnpm run typecheck'], ['lint', 'pnpm run lint'], ['test', 'pnpm run test']]);
    expect(d.repro_paths).toEqual(['tests/**', '**/__repro__/**']);
    expect(d.instruction_sources).toEqual(['AGENTS.md']);
    expect(d.instruction_candidates).toEqual(['.claude/skills/expert-review/SKILL.md']);
    expect(allowedCommandsFor(d)).toEqual(expect.arrayContaining(['pnpm run typecheck*', 'pnpm run test*', 'pnpm exec vitest*', 'node *']));

    const cfg = roundTrip(d);
    expect(cfg.verification.map((s) => s.run)).toEqual(['pnpm run typecheck', 'pnpm run lint', 'pnpm run test']);
    expect(cfg.instructions.sources).toEqual(['AGENTS.md']);
    expect(cfg.setup.run).toBe(d.setup?.run);
  });

  it('falls back to test runners when npm has only its placeholder test script', async () => {
    const d = await detect({
      'package.json': pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1' }, devDependencies: { vitest: '5', typescript: '7' } }),
      'package-lock.json': '{}',
      'tsconfig.json': '{}',
    });
    expect(d.setup?.run).toBe('npm ci');
    expect(d.steps.map((s) => s.run)).toEqual(['npx --no-install tsc --noEmit', 'npx --no-install vitest run']);
    roundTrip(d);
  });

  it('reads a uv project: ruff, mypy, pytest with junit', async () => {
    const d = await detect({
      'pyproject.toml': '[project]\nname = "x"\n[tool.ruff]\n[tool.mypy]\n[dependency-groups]\ndev = ["pytest"]\n',
      'uv.lock': '',
      'tests/test_x.py': '',
    });
    expect(d.stacks).toEqual(['python (uv)']);
    expect(d.setup?.run).toBe('uv sync --frozen');
    expect(d.steps.map((s) => [s.id, s.run])).toEqual([
      ['lint', 'uv run ruff check .'],
      ['typecheck', 'uv run mypy .'],
      ['test', 'uv run pytest -q --junitxml=.conductor/out/junit.xml'],
    ]);
    const cfg = roundTrip(d);
    expect(cfg.verification[2]).toMatchObject({ parse: 'junit', report_path: '.conductor/out/junit.xml' });
  });

  it('reads a requirements.txt Django app without pytest', async () => {
    const d = await detect({ 'requirements.txt': 'django\n', 'requirements-dev.txt': 'coverage\n', 'manage.py': '' });
    expect(d.setup?.run).toBe('python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt -r requirements-dev.txt');
    expect(d.steps.map((s) => s.run)).toEqual(['.venv/bin/python manage.py test']);
    roundTrip(d);
  });

  it('handles a repo with nothing recognisable, and still writes a valid file', async () => {
    const d = await detect({ 'README.md': '# hi' });
    expect(d.steps).toEqual([]);
    expect(d.warnings.some((w) => w.includes('add setup and verification by hand'))).toBe(true);
    const cfg = roundTrip(d);
    expect(cfg.verification).toEqual([]);
    expect(cfg.instructions.sources).toEqual([]);
  });

  it('keeps ids unique across stacks', async () => {
    const d = await detect({ 'package.json': pkg({ scripts: { test: 'jest' } }), 'go.mod': 'module x' });
    expect(d.steps.map((s) => s.id)).toEqual(['test', 'vet', 'test-2']);
    roundTrip(d);
  });

  it('skips a CLAUDE.md that only imports AGENTS.md, and uses a CLAUDE.md with content', async () => {
    const both = await detect({ 'AGENTS.md': '# a', 'CLAUDE.md': '@AGENTS.md\n' });
    expect(both.instruction_sources).toEqual(['AGENTS.md']);
    repo?.dispose();
    const claudeOnly = await detect({ 'CLAUDE.md': '# rules' });
    expect(claudeOnly.instruction_sources).toEqual(['CLAUDE.md']);
    expect(claudeOnly.warnings.some((w) => w.includes('move it into AGENTS.md'))).toBe(true);
  });

  it('never enables an uncommitted instruction file, and offers but never enables env files', async () => {
    const d = await detect({ '.gitignore': '.env*\n!.env.example\n', '.env.example': 'X=' });
    writeFileSync(join(repo!.root, 'AGENTS.md'), '# not committed');
    writeFileSync(join(repo!.root, '.env.test'), 'SECRET=1');
    const again = await detectRepo(repo!.root);
    expect(d.instruction_sources).toEqual([]);
    expect(again.instruction_sources).toEqual([]);
    expect(again.warnings.some((w) => w.includes('AGENTS.md is not committed'))).toBe(true);
    expect(again.env_files).toEqual(['.env.test']);
    expect(roundTrip(again).setup.copy_untracked).toEqual([]);
    expect(roundTrip({ ...again, copy_untracked: ['.env.test'] }).setup.copy_untracked).toEqual(['.env.test']);
  });

  it('writes operator-edited commands with awkward characters as valid YAML', async () => {
    const d = await detect({ 'package.json': pkg({ scripts: { test: 'vitest' } }) });
    d.steps[0]!.run = `pnpm test -- -t "it's: #1" && echo 'done' # really`;
    expect(roundTrip(d).verification[0]!.run).toBe(`pnpm test -- -t "it's: #1" && echo 'done' # really`);
  });
});

describe('commandPattern', () => {
  it('allows the program and its subcommands, not the whole tool', () => {
    expect(commandPattern('pnpm run typecheck')).toBe('pnpm run typecheck*');
    expect(commandPattern('uv run pytest -q --junitxml=.conductor/out/junit.xml')).toBe('uv run pytest*');
    expect(commandPattern('npx --no-install tsc --noEmit')).toBe('npx --no-install tsc*');
    expect(commandPattern('go vet ./...')).toBe('go vet*');
    expect(commandPattern('cargo check --all-targets')).toBe('cargo check*');
    expect(commandPattern('.venv/bin/python manage.py test')).toBe('.venv/bin/python manage.py test*');
    expect(commandPattern('node --version')).toBe('node --version*');
    expect(commandPattern('node --test test/')).toBe('node --test test/*');
    expect(commandPattern('make')).toBe('make*');
  });
});

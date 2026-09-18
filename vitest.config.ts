import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string, file = 'index.ts') =>
  fileURLToPath(new URL(`./packages/${pkg}/src/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@agent-conductor/adapter-api/conformance', replacement: src('adapter-api', 'conformance/index.ts') },
      { find: '@agent-conductor/adapter-api', replacement: src('adapter-api') },
      { find: '@agent-conductor/adapter-fake', replacement: src('adapter-fake') },
      { find: '@agent-conductor/adapter-claude', replacement: src('adapter-claude') },
      { find: '@agent-conductor/adapter-codex', replacement: src('adapter-codex') },
      { find: '@agent-conductor/core', replacement: src('core') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

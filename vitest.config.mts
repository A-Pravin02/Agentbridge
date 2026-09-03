import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // Integration tests share one SQLite file, so they must not run in
    // parallel processes. Correctness over speed for the security suite.
    pool: 'forks',
    // One process: the integration suite shares a single SQLite file.
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['packages/*/tests/**/*.test.ts', 'apps/api/tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts'],
      exclude: ['**/dist/**', '**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@agentbridge/shared-types': pkg('shared-types'),
      '@agentbridge/policy-engine': pkg('policy-engine'),
      '@agentbridge/threat-analyzer': pkg('threat-analyzer'),
      '@agentbridge/audit': pkg('audit'),
      '@agentbridge/payments': pkg('payments'),
    },
  },
});

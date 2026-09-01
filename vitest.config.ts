import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
  },
  resolve: {
    alias: {
      '@agentbridge/shared-types': new URL('./packages/shared-types/src/index.ts', import.meta.url).pathname.slice(1),
      '@agentbridge/policy-engine': new URL('./packages/policy-engine/src/index.ts', import.meta.url).pathname.slice(1),
      '@agentbridge/threat-analyzer': new URL('./packages/threat-analyzer/src/index.ts', import.meta.url).pathname.slice(1),
      '@agentbridge/audit': new URL('./packages/audit/src/index.ts', import.meta.url).pathname.slice(1),
    },
  },
});

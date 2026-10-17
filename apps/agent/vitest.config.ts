import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    // Agent request/step logs are noise in test output; failures still show assertion details.
    onConsoleLog: (msg) => !msg.includes('[agent]'),
    coverage: {
      provider: 'v8',
      include: ['src/decide.ts'],
      thresholds: { 'src/decide.ts': { lines: 100, branches: 100, functions: 100, statements: 100 } },
    },
  },
});

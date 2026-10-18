import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    // Only our tests: data/work holds unpacked deliveries, and their own *.test.js must never run here.
    include: ['test/**/*.test.ts'],
    // Agent request/step logs are noise in test output; failures still show assertion details.
    onConsoleLog: (msg) => !msg.includes('[agent]'),
    coverage: {
      provider: 'v8',
      include: ['src/decide.ts'],
      thresholds: { 'src/decide.ts': { lines: 100, branches: 100, functions: 100, statements: 100 } },
    },
  },
});

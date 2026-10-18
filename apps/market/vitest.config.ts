import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts: the root vitest bundles its own Vite, and the tests are plain TS.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
});

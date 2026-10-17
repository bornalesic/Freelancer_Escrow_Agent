import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts: the root vitest bundles its own Vite, and the tests are plain TS.
const realShared = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));
const shimShared = fileURLToPath(new URL('./src/shared-shim.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@escrow/shared': existsSync(realShared) ? realShared : shimShared },
  },
  test: { include: ['src/**/*.test.ts'] },
});

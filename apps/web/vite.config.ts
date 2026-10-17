import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Until packages/shared lands on main (WS3), `@escrow/shared` resolves to a local shim that mirrors
// docs/CONTRACTS.md. Once the real package exists it is used automatically; then delete the shim.
const realShared = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));
const shimShared = fileURLToPath(new URL('./src/shared-shim.ts', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Read VITE_* from the repo-root .env / .env.local, like every other process.
  envDir: '../..',
  resolve: {
    alias: { '@escrow/shared': existsSync(realShared) ? realShared : shimShared },
  },
  // 0.0.0.0 so the other laptops can open this screen over the LAN.
  server: { host: '0.0.0.0', port: 5173, strictPort: true },
  preview: { host: '0.0.0.0', port: 5173, strictPort: true },
});

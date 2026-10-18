import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Read VITE_* from the repo-root .env / .env.local, like every other process.
  envDir: '../..',
  // 5174: the old apps/web keeps 5173 until this app replaces it. 0.0.0.0 so the projector can be
  // opened from another laptop.
  server: { host: '0.0.0.0', port: 5174, strictPort: true },
  preview: { host: '0.0.0.0', port: 5174, strictPort: true },
});

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Read VITE_* from the repo-root .env / .env.local, like every other process.
  envDir: '../..',
  // The projector shows both parties' balances, using the URLs already in .env.example.
  envPrefix: ['VITE_', 'CLIENT_PARTY_URL', 'FREELANCER_PARTY_URL'],
  // 0.0.0.0 so the other laptops can open this screen over the LAN.
  server: { host: '0.0.0.0', port: 5173, strictPort: true },
  preview: { host: '0.0.0.0', port: 5173, strictPort: true },
});

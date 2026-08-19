import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// start-dev.ps1 takes a -ServerPort, but the proxy target used to be hard-coded at 3001 — so
// starting the server anywhere else produced a client that silently talked to the wrong (or no)
// server. Read it from the environment so the two actually stay in step, and so a second
// instance can be run alongside a live one without disturbing it.
const SERVER_PORT = process.env.PTCG_SERVER_PORT ?? '3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PTCG_CLIENT_PORT ?? 5173),
    proxy: {
      '/api': `http://localhost:${SERVER_PORT}`,
      '/ws': {
        target: `ws://localhost:${SERVER_PORT}`,
        ws: true,
      },
    },
  },
});
